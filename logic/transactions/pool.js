'use strict';

var async = require('async');
var _ = require('lodash');
var crypto = require('crypto');

var constants = require('../../helpers/constants.js');
var jobsQueue = require('../../helpers/jobsQueue.js');
var transactionTypes = require('../../helpers/transactionTypes.js');
var bignum = require('../../helpers/bignum.js');
var slots = require('../../helpers/slots.js');

// Private fields
var modules;
var library;
var self;
var __private = {};
var pool = {};

/**
 * Initializes variables and starts processPool/expiry/invalid timers.
 * @memberof module:transactions
 * @class
 * @classdesc Transaction pool logic.
 * @implements {processPool}
 * @implements {expireTransactions}
 * @implements {resetInvalidTransactions}
 * @param {bus} bus - Bus instance.
 * @param {Object} ed - Ed instance.
 * @param {object} transaction - Transaction logic instance.
 * @param {Account} account - Account logic instance.
 * @param {Object} logger - Logger instance.
 * @param {Object} configPool - Config values for the pool.
 * @param {function} cbPool - Callback function.
 */
// Constructor
function TransactionPool (bus, ed, transaction, account, logger, configPool, cbPool) {
	library = {
		logger: logger,
		bus: bus,
		ed: ed,
		logic: {
			transaction: transaction,
			account: account
		},
		config: {
			transactions: {
				pool: {
					storageLimit: configPool.storageLimit,
					processInterval: configPool.processInterval,
					expiryInterval: configPool.expiryInterval
				}
			}
		},
	};

	self = this;

	pool = {
		unverified: { transactions: {}, count: 0 },
		verified:{
			pending: { transactions: {}, count: 0 },
			ready: { transactions: {}, count: 0 }
		},
		invalid: { transactions: {}, count: 0 },
		broadcast: []
	};

	// Pool process timer
	function nextProcessPool (cb) {
		self.processPool(function (err) {
			if (err) {
				library.logger.log('ProcessPool transaction timer', err);
			}
			return setImmediate(cb);
		});
	}

	jobsQueue.register('transactionPoolNextProcess', nextProcessPool, library.config.transactions.pool.processInterval);

	// Transaction expiry timer
	function nextExpireTransactions (cb) {
		self.expireTransactions(function (err) {
			if (err) {
				library.logger.log('Transaction expiry timer', err);
			}
			return setImmediate(cb);
		});
	}

	jobsQueue.register('transactionPoolNextExpiryTransactions', nextExpireTransactions, library.config.transactions.pool.expiryInterval);

	// Invalid transactions reset timer
	function nextInvalidTransactionsReset () {
		library.logger.debug(['Cleared invalid transactions:', self.resetInvalidTransactions()].join(' '));
	}

	jobsQueue.register('transactionPoolNextInvalidTransactionsReset', nextInvalidTransactionsReset, library.config.transactions.pool.expiryInterval);

	if (cbPool) {
		return setImmediate(cbPool, null, self);
	}

	self.transactionsTypesUnique = [transactionTypes.SIGNATURE, transactionTypes.DELEGATE, transactionTypes.MULTI];
}


// Private
/**
 * Gets transactions from a pool list.
 * @private
 * @param {object} transactionsInPool - Name of pool list.
 * @param {boolean} reverse - Reverse order of results.
 * @param {number} limit - Limit applied to results.
 * @return {array} Of ordered transactions in pool list.
 */
__private.getTransactionsFromPoolList = function (transactionsInPool, reverse, limit) {
	var transactions = _.orderBy(transactionsInPool, ['receivedAt'],['asc']);

	transactions = reverse ? transactions.reverse() : transactions;

	if (limit) {
		transactions.splice(limit);
	}

	return transactions;
};

/**
 * Gets all transactions from the pool lists matching a search criteria.
 * @private
 * @param {Object} filter - Search criteria.
 * @return {Object} Of pool lists with matched transactions.
 */
__private.getAllTransactionsByFilter = function (filter) {
	var transactions = {
		unverified: _.filter(pool.unverified.transactions, filter),
		pending: _.filter(pool.verified.pending.transactions, filter),
		ready: _.filter(pool.verified.ready.transactions, filter)
	};

	return transactions;
};

/**
 * Checks if a transaction id is present in at least one of the pool lists.
 * @private
 * @param {string} id - Transaction id.
 * @return {boolean}
 */
__private.transactionInPool = function (id) {
	return [
		pool.verified.ready.transactions[id],
		pool.unverified.transactions[id],
		pool.verified.pending.transactions[id]
	].some(function (index) {
		return typeof(index) === 'object';
	});
};

/**
 * Checks if the pool is ready to receive a new transaction,
 * and whether the received transaction was already processed.
 * @private
 * @implements {__private.countTransactionsInPool}
 * @implements {__private.transactionInPool}
 * @param {object} transaction - Transaction object.
 * @param {function} cb - Callback function.
 * @return {setImmediateCallback} error | cb, transaction
 */
__private.checkPoolAvailability = function (transaction, cb) {
	if (pool.invalid.transactions[transaction.id] !== undefined) {
		return setImmediate(cb, 'Transaction is already processed as invalid: ' + transaction.id);
	}

	if (__private.transactionInPool(transaction.id)) {
		return setImmediate(cb, 'Transaction is already in pool: ' + transaction.id);
	}

	if (__private.countTransactionsInPool() >= library.config.transactions.pool.storageLimit) {
		return setImmediate(cb, 'Transaction pool is full');
	}

	return setImmediate(cb, null, transaction);
};

/**
 * Obtains the transaction sender from the accounts table.
 * If the sender's address does not exist, returns a default account object.
 * @private
 * @implements {modules.accounts.getSender}
 * @param {object} transaction - Transaction object.
 * @param {function} cb - Callback function.
 * @return {setImmediateCallback} error | cb, transaction, sender
 */
__private.getSender = function (transaction, cb) {
	modules.accounts.getSender({publicKey: transaction.senderPublicKey}, function (err, cbAccount) {
		return setImmediate(cb, err, transaction, cbAccount);
	});
};

/**
 * Obtains the transaction requester from the accounts table.
 * @private
 * @implements {modules.accounts.getAccount}
 * @param {object} transaction - Transaction object.
 * @param {Object} sender - Sender account.
 * @param {function} cb - Callback function.
 * @return {setImmediateCallback} error | cb, transaction, sender, requester
 */
__private.getRequester = function (transaction, sender, cb) {
	var isMultisignature = Array.isArray(sender.multisignatures) && sender.multisignatures.length > 0;

	if (isMultisignature) {
		transaction.signatures = transaction.signatures || [];
	}

	if (sender && transaction.requesterPublicKey && isMultisignature) {
		modules.accounts.getAccount({publicKey: transaction.requesterPublicKey}, function (err, requester) {
			if (!requester) {
				return setImmediate(cb, 'Requester not found');
			} else {
				return setImmediate(cb, null, transaction, sender, requester);
			}
		});
	} else {
		return setImmediate(cb, null, transaction, sender, null);
	}
};

/**
 * Processes a transaction.
 * @private
 * @implements {library.logic.transaction.process}
 * @implements {__private.addInvalid}
 * @param {object} transaction - Transaction object.
 * @param {Object} sender - Sender account.
 * @param {Object} requester - Requester account.
 * @param {function} cb - Callback function.
 * @return {setImmediateCallback} error | cb, transaction, sender
 */
__private.processTransaction = function (transaction, sender, requester, cb) {
	library.logic.transaction.process(transaction, sender, requester, function (err) {
		if (err) {
			__private.addInvalid(transaction.id);
			return setImmediate(cb, err);
		}

		return setImmediate(cb, null, transaction, sender);
	});
};

/**
 * Verifies a transaction.
 * @private
 * @implements {library.logic.transaction.verify}
 * @implements {__private.addInvalid}
 * @param {object} transaction - Transaction object.
 * @param {Object} sender - Sender account.
 * @param {function} cb - Callback function.
 * @return {setImmediateCallback} error | cb, transaction, sender
 */
__private.verifyTransaction = function (transaction, sender, cb) {
	library.logic.transaction.verify(transaction, sender, function (err) {
		if (err) {
			__private.addInvalid(transaction.id);
		}

		return setImmediate(cb, err, transaction, sender);
	});
};

/**
 * Verifies if a transaction type is already in the pool from the same sender.
 * @private
 * @implements {library.logic.transaction.verify}
 * @implements {__private.addInvalid}
 * @param {object} transaction - Transaction object.
 * @param {Object} sender - Sender account.
 * @param {function} cb - Callback function.
 * @return {setImmediateCallback} error | cb, transaction, sender
 */
__private.verifyTransactionTypeInPool = function (transaction, sender, cb) {
	var senderTransactions = _.filter(pool.verified.ready.transactions, {'senderPublicKey': transaction.senderPublicKey});

	if (senderTransactions.length > 0 && self.transactionsTypesUnique.indexOf(transaction.type) !== -1) {
		return setImmediate(cb, 'Transaction type already in pool for sender', transaction, sender);
	}

	return setImmediate(cb, null, transaction, sender);
};

/**
 * Adds a transaction to the verify, pending or ready pool list.
 * @private
 * @implements {__private.addToPoolList}
 * @implements {__private.addReadyAndPrepareBroadcast}
 * @param {object} transaction - Transaction object.
 * @param {function} cb - Callback function.
 * @return {setImmediateCallback} error | cb
 */
__private.moveToVerified = function (transaction, cb) {
	var receivedAt = transaction.receivedAt.getTime();
	var timestamp = slots.getRealTime(transaction.timestamp);

	// Add transactions to pending if they of type multisignature, they have signatures or timestamp is in future
	if (transaction.type === transactionTypes.MULTI || Array.isArray(transaction.signatures) || receivedAt < timestamp) {
		__private.addToPoolList(transaction, pool.verified.pending, cb);
	} else {
		__private.addReadyAndPrepareBroadcast(transaction, cb);
	}
};

/**
 * Adds a transaction to the verified pool list.
 * Checks if the transaction is in the pool, or if pool limit has been reached.
 * Performs basic and advanced transaction validations: verify and check balance.
 * @private
 * @implements {__private.checkPoolAvailability}
 * @implements {__private.getSender}
 * @implements {__private.getAccount}
 * @implements {__private.processTransaction}
 * @implements {__private.verifyTransaction}
 * @implements {__private.moveToVerified}
 * @param {object} transaction - Transaction object.
 * @param {boolean} broadcast - Broadcast flag.
 * @param {function} cb - Callback function.
 * @return {setImmediateCallback} error | cb
 */
__private.addToVerified = function (transaction, broadcast, cb) {
	transaction.receivedAt = new Date();
	async.waterfall([
		async.apply(__private.checkPoolAvailability, transaction),
		__private.getSender,
		__private.getRequester,
		__private.processTransaction,
		__private.verifyTransaction,
		__private.verifyTransactionTypeInPool,
		function checkBalance (transaction, sender, waterCb) {
			self.checkBalance(transaction, sender, function (err, balance) {
				if (err) {
					return setImmediate(waterCb, err);
				}
				return __private.moveToVerified(transaction, waterCb);
			});
		}
	], function (err) {
		return setImmediate(cb, err);
	});

};

/**
 * Adds a transaction to the unverified pool list.
 * Checks if the transaction is in the pool, or if pool limit has been reached.
 * Performs basic transaction validations.
 * @private
 * @implements {__private.checkPoolAvailability}
 * @implements {__private.getSender}
 * @implements {__private.getAccount}
 * @implements {__private.processTransaction}
 * @param {object} transaction - Transaction object.
 * @param {boolean} broadcast - Broadcast flag.
 * @param {function} cb - Callback function.
 * @return {setImmediateCallback} error | cb
 */
__private.addToUnverified = function (transaction, broadcast, cb) {
	async.waterfall([
		async.apply(__private.checkPoolAvailability, transaction),
		__private.getSender,
		__private.getRequester,
		__private.processTransaction
	], function (err, transaction, sender) {
		if (!err) {
			if (broadcast) {
				transaction.broadcast = true;
			}
			transaction.receivedAt = new Date();
			pool.unverified.transactions[transaction.id] = transaction;
			pool.unverified.count++;
		}
		return setImmediate(cb, err, transaction);
	});

};

/**
 * Adds a transaction to the pool list.
 * Increments pool list counter only if transaction id is not present.
 * @private
 * @param {object} transaction - Transaction object.
 * @param {Object} poolList - Pool list object.
 * @param {function} cb - Callback function.
 * @return {setImmediateCallback} error | cb
 */
__private.addToPoolList = function (transaction, poolList, cb) {
	if (poolList.transactions[transaction.id] === undefined) {
		poolList.count++;
	}

	// Equalize sender address
	if (!transaction.senderId) {
		transaction.senderId = modules.accounts.generateAddressByPublicKey(transaction.senderPublicKey);
	}

	poolList.transactions[transaction.id] = transaction;
	return setImmediate(cb);
};

/**
 * Adds a transaction to the ready pool list.
 * Adds the transaction to the broadcast queue if its broadcast flag is true.
 * @private
 * @param {object} transaction - Transaction object.
 * @param {function} cb - Callback function.
 * @return {setImmediateCallback} error | cb
 */
__private.addReadyAndPrepareBroadcast = function (transaction, cb) {
	if (transaction.broadcast) {
		delete transaction.broadcast;
		pool.broadcast.push(transaction);
	}
	__private.addToPoolList(transaction, pool.verified.ready, cb);
};

/**
 * Creates a signature for the given multisignature transaction and secret.
 * @private
 * @param {object} transaction - Transaction object.
 * @param {String} secret - Secret passphrase,
 * @param {function} cb - Callback function.
 * @return {setImmediateCallback} error | cb
 */
__private.createSignature = function (transaction, secret, cb) {
	var hash = crypto.createHash('sha256').update(secret, 'utf8').digest();
	var keypair = library.ed.makeKeypair(hash);
	var publicKey = keypair.publicKey.toString('hex');

	if (transaction.asset.multisignature.keysgroup.indexOf('+' + publicKey) === -1) {
		return setImmediate(cb, 'Permission to sign transaction denied');
	}

	var signature = library.logic.transaction.multisign(keypair, transaction);
	return setImmediate(cb, null, signature);
};

/**
 * Adds a transaction id to the invalid pool list.
 * @private
 * @param {string} id - Transaction id.
 */
__private.addInvalid = function (id) {
	pool.invalid.transactions[id] = true;
	pool.invalid.count++;
};

/**
 * Deletes a transaction by id from a pool list.
 * @private
 * @param {string} id - Transaction id.
 * @param {Object} poolList - Pool list object.
 * @return {boolean} True if transaction id was found and deleted.
 */
__private.delete = function (id, poolList) {
	var transaction = poolList.transactions[id];

	if (transaction !== undefined) {
		poolList.transactions[id] = undefined;
		delete poolList.transactions[id];
		poolList.count--;
		return true;
	} else {
		return false;
	}
};

/**
 * Sums unverified, verified.pending and verified.ready counters.
 * @private
 * @return {Number} Of unverified + pending + ready.
 */
__private.countTransactionsInPool = function () {
	return pool.unverified.count + pool.verified.pending.count + pool.verified.ready.count;
};

/**
 * Removes expired transactions from a pool list.
 * @private
 * @implements {__private.getTransactionTimeOut}
 * @implements {__private.delete}
 * @param {Object} poolList - Pool list object.
 * @param {function} cb - Callback function.
 * @return {setImmediateCallback} cb|error
 */
__private.expireTransactionsFromList = function (poolList, cb) {
	async.each(poolList.transactions, function (transaction, eachCb) {
		if (!transaction) {
			return setImmediate(eachCb);
		}

		var timeNow = Math.floor(Date.now() / 1000);
		var timeOut = __private.getTransactionTimeOut(transaction);
		// transaction.receivedAt is instance of Date
		var seconds = timeNow - Math.floor(transaction.receivedAt.getTime() / 1000);

		if (seconds > timeOut) {
			__private.delete(transaction.id, poolList);
			library.logger.info('Expired transaction: ' + transaction.id + ' received at: ' + transaction.receivedAt.toUTCString());
		}

		return setImmediate(eachCb);
	}, function () {
		return setImmediate(cb);
	});
};

/**
 * Calculates expiry timeout for a transaction based on type.
 * @private
 * @param {object} transaction - Transaction object.
 * @return {number} Of transaction timeout.
 */
__private.getTransactionTimeOut = function (transaction) {
	if (transaction.type === transactionTypes.MULTI) {
		return (transaction.asset.multisignature.lifetime * constants.secondsPerHour);
	} else if (Array.isArray(transaction.signatures)) {
		return (constants.unconfirmedTransactionTimeOut * constants.signatureTransactionTimeOutMultiplier);
	} else {
		return (constants.unconfirmedTransactionTimeOut);
	}
};

/**
 * Gets the transaction sender from the accounts table, and then verifies the transaction.
 * @private
 * @implements {__private.getSender}
 * @implements {__private.verifyTransaction}
 * @param {object} transaction - Transaction object.
 * @param {function} cb - Callback function.
 * @returns {setImmediateCallback} errors | sender
 */
__private.processUnverifiedTransaction = function (transaction, cb) {
	async.waterfall([
		async.apply(__private.getSender, transaction),
		__private.verifyTransaction
	], function (err, transaction, sender) {
		return setImmediate(cb, err, sender);
	});
};

// Public methods
/**
 * Bounds input parameters to private variable modules.
 * @param {Accounts} accounts - Accounts module instance.
 */
TransactionPool.prototype.bind = function (accounts) {
	modules = {
		accounts: accounts,
	};
};

/**
 * Deletes transactions from pool ready until account balance becomes zero or positive.
 * @private
 * @implements {self.delete}
 * @param {[transaction]} transactions - Array of transactions.
 * @param {string} balance - Balance of account.
 */
__private.popFromReadyUntilCredit = function (transactions, balance) {
	var transaction;
	var transactionsToDelete;

	transactionsToDelete = transactions.find(function (transaction) {
		return balance.plus(transaction.amount.toString()).plus(transaction.fee.toString()).isZero;
	});

	if (transactionsToDelete === undefined) {
		transactionsToDelete = _.orderBy(transactions, [function (transaction) {
			return transaction.amount + transaction.fee;
		}, 'id'], ['desc', 'desc']);
	}

	if (!Array.isArray(transactionsToDelete)) {
		transactionsToDelete = [transactionsToDelete];
	}

	while (balance.lessThan('0') && transactionsToDelete.length > 0) {
		transaction = transactionsToDelete.pop();
		self.delete(transaction.id);
		balance = balance.plus(transaction.amount.toString()).plus(transaction.fee.toString());
	}

	return;
};

/**
 * Gets invalid, unverified, verified.pending and verified.ready counters.
 * @implements {__private.countTransactionsInPool}
 * @return {Object} unverified, pending, ready
 */
TransactionPool.prototype.getUsage = function () {
	return {
		unverified: pool.unverified.count,
		pending: pool.verified.pending.count,
		ready: pool.verified.ready.count,
		invalid: pool.invalid.count,
		total: __private.countTransactionsInPool()
	};
};

/**
 * Gets a transaction by id.
 * Checks all pool lists: unverified, pending, ready.
 * @param {string} id - Transaction id.
 * @return {Object} transaction, status
 */
TransactionPool.prototype.get = function (id) {
	var transaction = pool.unverified.transactions[id];
	if (transaction !== undefined) {
		return {
			transaction: transaction,
			status: 'unverified'
		};
	}

	transaction = pool.verified.pending.transactions[id];
	if (transaction !== undefined) {
		return {
			transaction: transaction,
			status: 'pending'
		};
	}

	transaction = pool.verified.ready.transactions[id];
	if (transaction !== undefined) {
		return {
			transaction: transaction,
			status: 'ready'
		};
	}

	return {
		transaction: undefined,
		status: 'Transaction not in pool'
	};
};

/**
 * Gets all transactions matching a search criteria.
 * @implements {__private.getTransactionsFromPoolList}
 * @implements {__private.getAllTransactionsByFilter}
 * @param {string} filter - Search criteria.
 * @param {Object} params - Parameters given to each pool list.
 * @return {array} Of matched transactions.
 */
TransactionPool.prototype.getAll = function (filter, params) {
	switch (filter) {
		case 'unverified':
			return __private.getTransactionsFromPoolList(pool.unverified.transactions, params.reverse, params.limit);
		case 'pending':
			return __private.getTransactionsFromPoolList(pool.verified.pending.transactions, params.reverse, params.limit);
		case 'ready':
			return __private.getTransactionsFromPoolList(pool.verified.ready.transactions, params.reverse, params.limit);
		case 'sender_id':
			return __private.getAllTransactionsByFilter({'senderId': params.id});
		case 'sender_pk':
			return __private.getAllTransactionsByFilter({'senderPublicKey': params.publicKey});
		case 'recipient_id':
			return __private.getAllTransactionsByFilter({'recipientId': params.id});
		case 'recipient_pk':
			return __private.getAllTransactionsByFilter({'requesterPublicKey': params.publicKey});
		default:
			return 'Invalid filter';
	}
};

/**
 * Gets ready transactions ordered by fee and received time.
 * @param {number} limit - Limit applied to results.
 * @return {transaction[]}
 */
TransactionPool.prototype.getReady = function (limit) {
	var transactionsReady = _.orderBy(pool.verified.ready.transactions, ['fee', 'receivedAt', 'id'],['desc', 'asc', 'desc']);

	if (limit && limit < transactionsReady.length) {
		transactionsReady.splice(limit);
	}

	return transactionsReady;
};

/**
 * Checks if a sender has enough funds to apply a transaction.
 * Balance - (debits + credits) should be equal or greather than transaction fee + amount.
 * @param {object} transaction - Transaction object.
 * @param {address} sender - Sender address.
 * @param {function} cb - Callback function.
 * @return {setImmediateCallback} err, transactions
 */
TransactionPool.prototype.checkBalance  = function (transaction, sender, cb) {
	var poolBalance = new bignum('0');
	var paymentTransactions;
	var receiptTransactions;

	library.logic.account.get({address: sender.address}, 'balance', function (err, account) {
		if (err) {
			return setImmediate(cb, err);
		}

		if (account === null) {
			account = {};
			account.balance = 0;
		}

		// Total payments
		paymentTransactions = self.getAll('sender_id', {id: sender.address});
		if (paymentTransactions.ready.length > 0) {
			paymentTransactions.ready.forEach(function (paymentTransaction) {
				if (paymentTransaction.amount) {
					poolBalance = poolBalance.minus(paymentTransaction.amount.toString());
				}
				poolBalance = poolBalance.minus(paymentTransaction.fee.toString());
			});
		}

		// Total receipts
		receiptTransactions = self.getAll('recipient_id', {id: sender.address});
		if (receiptTransactions.ready.length > 0) {
			receiptTransactions.ready.forEach(function (receiptTransaction) {
				if (receiptTransaction.type === transactionTypes.SEND) {
					poolBalance = poolBalance.plus(receiptTransaction.amount.toString());
				}
			});
		}

		// Total balance
		var balance = new bignum(account.balance.toString());
		balance = balance.plus(poolBalance);

		// Check confirmed sender balance
		var amount = new bignum(transaction.amount.toString()).plus(transaction.fee.toString());
		var exceeded = balance.lessThan(amount);

		if (exceeded) {
			return setImmediate(cb, [
				'Account does not have enough LSK:', sender.address,
				'balance:', balance.div(Math.pow(10,8))
			].join(' '), balance);
		}

		return setImmediate(cb, null, balance);
	});
};

/**
 * Validates a transaction and adds it to the verified pool list.
 * @implements {__private.addToVerified}
 * @param {object} transaction - Transaction object.
 * @param {boolean} broadcast - Broadcast flag.
 * @param {function} cb - Callback function.
 * @return {setImmediateCallback} error | cb
 */
TransactionPool.prototype.addFromPublic = function (transaction, broadcast, cb) {
	__private.addToVerified(transaction, broadcast, cb);
};

/**
 * Adds an array of transactions to the unverified pool list.
 * @implements {__private.addToUnverified}
 * @param {array} transactions - Array of transactions.
 * @param {boolean} broadcast - Broadcast flag.
 * @param {function} cb - Callback function.
 * @return {setImmediateCallback} error | cb
 */
TransactionPool.prototype.addFromPeer = function (transactions, broadcast, cb) {
	if (!Array.isArray(transactions)) {
		transactions = [transactions];
	}

	async.eachSeries(transactions, function (transaction, cb) {
		__private.addToUnverified(transaction, broadcast, cb);
	}, function (err) {
		return setImmediate(cb, err);
	});
};

/**
 * Adds an array of transactions to the verified.ready pool list.
 * @implements {__private.addToPoolList}
 * @implements {delete}
 * @param {[transaction]} transactions - Array of transactions.
 * @param {function} cb - Callback function.
 * @return {setImmediateCallback} error | cb
 */
TransactionPool.prototype.addReady = function (transactions, cb) {
	var resetReceivedAt = new Date();

	async.eachSeries(transactions, function (transaction, eachSeriesCb) {
		self.delete(transaction.id);
		transaction.receivedAt = resetReceivedAt;
		__private.addToPoolList(transaction, pool.verified.ready, eachSeriesCb);
	}, function (err) {
		return setImmediate(cb, err);
	});
};

/**
 * Creates and adds a signature to a multisignature transaction.
 * @implements {__private.createSignature}
 * @param {String} transactionId - Transaction id.
 * @param {String} secret - Secret passphrase.
 * @param {function} cb - Callback function.
 * @return {setImmediateCallback} error | cb
 */
TransactionPool.prototype.addSignature = function (transactionId, secret, cb) {
	var multisignatureTransaction = pool.verified.pending.transactions[transactionId];

	if (multisignatureTransaction === undefined) {
		library.logger.error(['Failed to add signature to multisignature. Transaction', transactionId, 'not in pool'].join(' '));
		return setImmediate(cb, 'Transaction not in pool');
	}

	// TODO: Replace with checkSignature to reflect API 1.0.18 functionality
	__private.createSignature(multisignatureTransaction, secret, function (err, signature) {
		if (err) {
			return setImmediate(cb, err);
		}
		if (multisignatureTransaction.signatures.indexOf(signature) !== -1) {
			library.logger.error(['Transaction already signed:', transactionId].join(' '));
			return setImmediate(cb, 'Transaction already signed');
		}

		multisignatureTransaction.signatures.push(signature);
		return setImmediate(cb);
	});
};

/**
 * Deletes a transaction from the pool lists by id.
 * @implements {__private.delete}
 * @param {string} id - Transaction id.
 * @return {Array} Of cleared pool lists.
 */
TransactionPool.prototype.delete = function (id) {
	var clearedList = [];
	var poolList = ['unverified','pending','ready'];

	[pool.unverified, pool.verified.pending, pool.verified.ready].forEach(function (list, index) {
		if (__private.delete(id, list)) {
			clearedList.push(poolList[index]);
		}
	});

	if (clearedList.length > 1) {
		library.logger.debug(['Cleared duplicated transaction in pool list:', clearedList, 'transaction id:', id].join(' '));
	}

	return clearedList[0] ? clearedList[0] : undefined;
};

/**
 * Deletes transactions from pool lists, and rechecks balance for ready transactions.
 * @implements {self.delete}
 * @implements {self.checkBalance}
 * @implements {__private.popFromReadyUntilCredit}
 * @param {string} id - Transaction id.
 * @param {function} cb - Callback function.
 * @return {setImmediateCallback} cb
 */
TransactionPool.prototype.sanitizeTransactions = function (transactions, cb) {
	async.eachSeries(transactions, function (transaction, eachSeriesCb) {
		self.delete(transaction.id);

		var readyTransactions = _.filter(pool.verified.ready.transactions, {'senderId': transaction.senderId});

		if (readyTransactions.length > 0) {
			self.checkBalance({amount: 0, fee: 0}, {address: transaction.senderId}, function (err, balance) {
				if (err) {
					__private.popFromReadyUntilCredit(readyTransactions, balance);
				}
				return setImmediate(eachSeriesCb);
			});
		} else {
			return setImmediate(eachSeriesCb);
		}

	}, function () {
		return setImmediate(cb);
	});
};

/**
 * Pulls transactions from unverified, performs verifications, and if successful
 * pushes them to either verified.pending (when transaction is multisign or timestamp is in
 * future), otherwise to verified.ready.
 * @implements {__private.delete}
 * @implements {__private.processUnverifiedTransaction}
 * @implements {self.checkBalance}
 * @implements {__private.moveToVerified}
 * @implements {__private.addReadyAndPrepareBroadcast}
 * @param {function} cb - Callback function.
 * @return {setImmediateCallback} err | cb
 */
TransactionPool.prototype.processPool = function (cb) {
	async.series({
		processUnverified: function (seriesCb) {
			if (pool.unverified.count === 0) {
				return setImmediate(seriesCb);
			}

			async.eachSeries(pool.unverified.transactions, function (transaction, eachSeriesCb) {
				__private.delete(transaction.id, pool.unverified);
				__private.processUnverifiedTransaction(transaction, function (err, sender) {
					if (err) {
						library.logger.error('Failed to process unverified transaction: ' + transaction.id, err);
						return setImmediate(eachSeriesCb);
					}
					self.checkBalance(transaction, sender, function (err, balance) {
						if (err) {
							library.logger.error('Failed to check balance for account related with transaction: ' + transaction.id, err);
							return setImmediate(eachSeriesCb);
						}
						return __private.moveToVerified(transaction, eachSeriesCb);
					});
				});
			}, function (err) {
				return setImmediate(seriesCb, err);
			});
		},
		processPending: function (seriesCb) {
			if (pool.verified.pending.count === 0) {
				return setImmediate(seriesCb);
			}
			// Process pool.verified.pending (multisig transactions signs), and moves
			// transactions from `verified.pending` to `verified.ready`
			async.eachSeries(pool.verified.pending.transactions, function (transaction, eachSeriesCb) {
				// Check multisignatures
				if (transaction.type === transactionTypes.MULTI &&
					Array.isArray(transaction.signatures) &&
					transaction.signatures.length >= transaction.asset.multisignature.min
				) {
					__private.delete(transaction.id, pool.verified.pending);
					__private.addReadyAndPrepareBroadcast(transaction, eachSeriesCb);
				} else {
					return setImmediate(eachSeriesCb);
				}
			}, function (err) {
				return setImmediate(seriesCb, err);
			});
		}
	}, function (err) {
		library.bus.message('unverifiedTransaction', pool.broadcast);
		pool.broadcast = [];
		return setImmediate(cb, err);
	});
};

/**
 * Expires transactions according to their individual timeout.
 * @implements {__private.expireTransactionsFromList}
 * @param {function} cb - Callback function.
 * @return {setImmediateCallback} error, cb
 */
TransactionPool.prototype.expireTransactions = function (cb) {
	async.series([
		function (seriesCb) {
			__private.expireTransactionsFromList(pool.unverified, seriesCb);
		},
		function (seriesCb) {
			__private.expireTransactionsFromList(pool.verified.pending, seriesCb);
		},
		function (seriesCb) {
			__private.expireTransactionsFromList(pool.verified.ready, seriesCb);
		}
	], function (err) {
		return setImmediate(cb, err);
	});
};

/**
 * Reset invalid transactions.
 * @return {number} Of invalid transactions reset.
 */
TransactionPool.prototype.resetInvalidTransactions = function () {
	var counter = 0;
	var transaction;

	for (transaction in pool.invalid.transactions) {
		delete pool.invalid.transactions[transaction];
		counter++;
	}

	pool.invalid.count = 0;
	return counter;
};

// Export
module.exports = TransactionPool;