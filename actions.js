(function() {

/**
 * Script to block a list of screen names using credentials for a given user id
 */
var twitterAPI = require('node-twitter-api'),
    fs = require('fs'),
    _ = require('sequelize').Utils._,
    setup = require('./setup');

var twitter = setup.twitter,
    logger = setup.logger,
    BtUser = setup.BtUser,
    UnblockedUser = setup.UnblockedUser,
    Action = setup.Action;

/**
 * Given a list of uids, enqueue them all in the Actions table, and trigger a
 * batch of processing Actions for the source user.
 *
 * TODO: Once all the actions are created, this should kick off a processing run
 * for the triggering user. Need to figure out how to do Promise joins.
 *
 * @param {string} source_uid The user who wants to perform these actions.
 * @param {Array.<string>} list A list of uids to target with the actions.
 * @param {type} type The type of action, e.g block/unblock.
 * @param {string} cause The cause to be recorded on the Actions.
 * @param {string} cause_uid Uid of the user who caused the actions, e.g.
 *    the author of a shared block list if cause is 'bulk-manual-block.'
 */
function queueActions(source_uid, list, type, cause, cause_uid) {
  Action.bulkCreate(
    list.map(function(sink_uid) {
      return {
        source_uid: source_uid,
        sink_uid: sink_uid,
        type: type,
        cause: cause,
        cause_uid: cause_uid
      }
    })).error(function(err) {
      logger.error(err);
    }).success(function(actions) {
      processActionsForUserId(source_uid);
    });
}

/**
 * Find all pending block actions in the queue, validate and execute them.
 *
 * Validation is a little tricky.  We want to check whether a given
 * user is following the target. The relevant endpoint is friendships/lookup,
 * https://dev.twitter.com/docs/api/1.1/get/friendships/lookup.
 * That endpoint has a rate limit of 15 requests per 15 minutes, which means
 * bulk blocking would proceed very slowly if we called it once per block
 * action.
 *
 * However, friendships/lookup supports bulk querying of up to 100 users at
 * once. So we group pending actions by source_uid, then do a second query by
 * that uid to get up to 100 of their oldest pending actions. To make sure this
 * query never gets jammed up with unprocessable actions, it's important that
 * each action queried gets moved out of pending state in one way or
 * another.
 *
 * Note that the block endpoint can only block one user
 * at a time, but it does not appear to have a rate limit.
 */
function processActions() {
  Action.findAll({
    where: ['status = "pending"'],
    group: 'source_uid',
    limit: 300
  }).error(function(err) {
    logger.error(err);
  }).success(function(actions) {
    actions.forEach(function(action) {
      processActionsForUserId(action.source_uid);
    });
  })
}

/**
 * For a given user id, fetch and process pending actions.
 * @param {string} uid The uid of the user to process.
 */
function processActionsForUserId(uid) {
  BtUser
    .find({
      where: { uid: uid },
      include: [UnblockedUser]
    }).error(function(err) {
      logger.error(err);
    }).success(function(btUser) {
      if (!btUser || btUser.deactivatedAt) {
        // Defer all pending actions for deactivated or absent users.
        logger.error('User missing or deactivated', uid);
        deferSourceDeactivated(uid);
      } else {
        getActions(btUser, 'block', processBlocksForUser);
        getActions(btUser, 'unblock', processUnblocksForUser);
        getActions(btUser, 'mute', processMutesForUser);
      }
    });
}

/**
 * Find all actions of a given type for btUser, and call callback with
 * btUser and actions. If there is an error or there are no actions, callback
 * will not be called.
 *
 * @param {BtUser} btUser The user whose actions we're going to process.
 * @param {string} type The type of actions to look for.
 * @param {Function} callback A function taking (BtUser, Action[]). Called only
 *   on success.
 */
function getActions(btUser, type, callback) {
  // We use a nested fetch here rather than an include because the actions
  // for a user can be quite large. The SQL generated by a BtUser.find
  // with an include statement has two problems: (1) It doesn't respect
  // the limit clause, and (2) each row returned for Actions also includes
  // the full BtUser object, which contains some long strings. This is
  // very wasteful.
  btUser.getActions({
    // Out of the available pending block actions on this user,
    // pick up to 100 with the earliest updatedAt times.
    where: {
      status: 'pending',
      type: type
    },
    order: 'updatedAt ASC',
    limit: 100
  }).error(function(err) {
    logger.error(err);
  }).success(function(actions) {
    if (actions && actions.length > 0) {
      callback(btUser, actions);
    }
  });
}

/**
 * For a uid that has been determined to be deactivated, mark all of that
 * user's actions with status = DEFERRED_SOURCE_DEACTIVATED.
 *
 * @param {string} uid User id for whom to modify actions.
 */
function deferSourceDeactivated(uid) {
  Action.update({
    status: Action.DEFERRED_SOURCE_DEACTIVATED
  }, { /* where */
    source_uid: uid
  }).error(function(err) {
    logger.error(err);
  })
}

function block(sourceBtUser, sinkUid, callback) {
  twitter.blocks('create', {
      user_id: sinkUid,
      skip_status: 1
    }, sourceBtUser.access_token, sourceBtUser.access_token_secret,
    callback);
}

function unBlock(sourceBtUser, sinkUid, callback) {
  twitter.blocks('destroy', {
      user_id: sinkUid,
      skip_status: 1
    }, sourceBtUser.access_token, sourceBtUser.access_token_secret,
    callback);
}

function mute(sourceBtUser, sinkUid, callback) {
  twitter.mutes('users/create', {
      user_id: sinkUid,
      skip_status: 1
    }, sourceBtUser.access_token, sourceBtUser.access_token_secret,
    callback);
}

function processUnblocksForUser(btUser, actions) {
  // NOTE: We do not bother looking up friendships before unblocking or muting,
  // because there's no special treatment for people you follow the way there is
  // for blocks. This also means that we miss a few of the less common
  // transitions, like cancelled-duplicate, but these are probably not super
  // important.
  // Also NOTE: We kick off all unblock requests simultaneously rather than
  // sequentially in callbacks the way we do for blocks. This is probably fine.
  // The https library should simply queue the requests until there is an
  // available socket for them. We may want to simplify the blocks code to do
  // the same.
  actions.forEach(function(action) {
    if (action.type != 'unblock') {
      logger.error("Shouldn't happen: non-unblock action", btUser);
    }
    unBlock(btUser, action.sink_uid, function(err, results) {
      if (err) {
        logger.error('Error /blocks/destroy', err.statusCode, btUser,
          '-->', action.sink_uid);
      } else {
        logger.info('Unblocked', btUser, '-->', action.sink_uid);
        setActionStatus(action, Action.DONE);
      }
    });
  });
}

function processMutesForUser(btUser, actions) {
  actions.forEach(function(action) {
    if (action.type != 'mute') {
      logger.error("Shouldn't happen: non-mute action", btUser);
    }
    mute(btUser, action.sink_uid, function(err, results) {
      if (err) {
        logger.error('Error /mutes/users/create', err.statusCode, btUser,
          '-->', action.sink_uid);
      } else {
        logger.info('Muted', btUser, '-->', action.sink_uid);
        setActionStatus(action, Action.DONE);
      }
    });
  });
}

/**
 * Given a BtUser and a subset of that user's pending blocks, process
 * as appropriate.
 *
 * @param {BtUser} btUser The user whose Actions we should process.
 * @param {Array.<Action>} actions Actions to process.
 */
function processBlocksForUser(btUser, actions) {
  // Now that we've got our list, send them to Twitter to see if the
  // btUser follows them.
  var sinkUids = _.pluck(actions, 'sink_uid');
  blockUnlessFollowing(btUser, sinkUids, actions);
}

/**
 * Given fewer than 100 sinkUids, check the following relationship between
 * sourceBtUser and those each sinkUid, and block if there is not an existing
 * follow or block relationship. Then update the Actions provided.
 *
 * @param {BtUser} sourceBtUser The user doing the blocking.
 * @param {Array.<integer>} sinkUids A list of uids to potentially block.
 * @param {Array.<Action>} actions The Actions to be updated based on the results.
 */
function blockUnlessFollowing(sourceBtUser, sinkUids, actions) {
  if (sinkUids.length > 100) {
    logger.error('No more than 100 sinkUids allowed. Given', sinkUids.length);
    return;
  }
  logger.debug('Checking follow status', sourceBtUser,
    '--???-->', sinkUids.length, 'users');
  twitter.friendships('lookup', {
      user_id: sinkUids.join(',')
    }, sourceBtUser.access_token, sourceBtUser.access_token_secret,
    function(err, friendships) {
      if (err && err.statusCode === 401) {
        sourceBtUser.verifyCredentials();
      } else if (err) {
        logger.error('Error /friendships/lookup', err.statusCode, 'for',
          sourceBtUser.screen_name, err.data);
      } else {
        var indexedFriendships = _.indexBy(friendships, 'id_str');
        blockUnlessFollowingWithFriendships(
          sourceBtUser, indexedFriendships, actions);
      }
    });
}

/**
 * After fetching friendships results from the Twitter API, process each one,
 * one at a time, and block if appropriate. This function calls itself
 * recursively in the callback from the Twitter API, to avoid queuing up large
 * numbers of HTTP requests abruptly. NOTE: This async recursion is a little
 * confusing and may not be necessary. The original incident that prompted
 * adding it was that when processing large batches, Block Together would get
 * connection hangup from Twitter. However, several other bug fixes went in
 * around the same time, and any one of them may have been the "real" fix.
 *
 * @param{BtUser} sourceBtUser The user doing the blocking.
 * @param{Object} indexedFriendships A map from uids to friendship objects as
 *   returned by the Twitter API.
 * @param{Array.<Action>} actions The list of actions to be performed or state
 *   transitioned.
 */
function blockUnlessFollowingWithFriendships(
    sourceBtUser, indexedFriendships, actions) {
  if (!actions || actions.length < 1) {
    return;
  }
  var next = blockUnlessFollowingWithFriendships.bind(
      undefined, sourceBtUser, indexedFriendships, actions.slice(1));
  var action = actions[0];
  // Sanity check that this is a block, not some other action.
  if (action.type != 'block') {
    logger.error("Shouldn't happen: non-block action", sourceBtUser);
    next();
  }
  var sink_uid = action.sink_uid;
  var friendship = indexedFriendships[sink_uid];
  // Decide which state to transition the Action into, if it's not going to be
  // executed.
  var newState = null;

  // If no friendship for this action was returned by /1.1/users/lookup,
  // that means the sink_uid was suspened or deactivated, so defer the Action.
  if (!friendship) {
    newState = Action.DEFERRED_TARGET_SUSPENDED;
  } else if (_.contains(friendship.connections, 'blocking')) {
    // If the sourceBtUser already blocks them, don't re-block.
    newState = Action.CANCELLED_DUPLICATE;
  } else if (_.contains(friendship.connections, 'following')) {
    // If the sourceBtUser follows them, don't block.
    newState = Action.CANCELLED_FOLLOWING;
  } else if (_.find(sourceBtUser.unblockedUsers, {sink_uid: sink_uid})) {
    // If the user unblocked the sink_uid in the past, don't re-block.
    newState = Action.CANCELLED_UNBLOCKED;
  } else if (sourceBtUser.uid === sink_uid) {
    // You cannot block yourself.
    newState = Action.CANCELLED_SELF;
  }
  // If we're cancelling, update the state of the action. It's
  // possible to have multiple pending Blocks for the same sink_uid, so
  // we have to do a forEach across the available Actions.
  if (newState) {
    setActionStatus(action, newState, next);
  } else {
    // No obstacles to blocking the sink_uid have been found, block 'em!
    // TODO: Don't kick off all these requests to Twitter
    // simultaneously; instead chain them.
    logger.debug('Creating block', sourceBtUser.screen_name,
      '--block-->', friendship.screen_name, sink_uid);
    block(sourceBtUser, sink_uid, function(err, results) {
      if (err) {
        logger.error('Error /blocks/create', err.statusCode,
          sourceBtUser.screen_name, sourceBtUser.uid,
          '--block-->', friendship.screen_name, friendship.id_str,
          err.data);
      } else {
        logger.info('Blocked ', sourceBtUser.screen_name, sourceBtUser.uid,
          '--block-->', results.screen_name, results.id_str);
        setActionStatus(action, Action.DONE, next);
      }
    });
  }
}

function nothing() {
}

/**
 * Set an actions status to newState, save it, and call the `next' callback
 * regardless of success or error.
 */
function setActionStatus(action, newState, next) {
  next = next || nothing;
  action.status = newState;
  action.save().error(function(err) {
    logger.error(err);
    next();
  }).success(next);
}

module.exports = {
  queueActions: queueActions,
  processActionsForUserId: processActionsForUserId
};

if (require.main === module) {
  // TODO: It's possible for one run of processActions could take more than 60
  // seconds, in which case we wind up with multiple instances running
  // concurrently. This probably won't happen since each run only processes 100
  // items per user, but with a lot of users it could, and would lead to some
  // redundant work as each instance tried to grab work from a previous
  // instance. Figure out a way to prevent this while being robust (i.e. not
  // having to make sure every possible code path calls a finishing callback).
  processActions();
  setInterval(processActions, 60 * 1000);
}
})();
