const assert = require('assert');
const helpers = require('./../helpers');
const consts = require('./../constants').Constants;
const crypto = require('crypto');
const async = require('async');

const { Transform } = require('stream');

const kSource = Symbol("source");
const kCache = Symbol("cache");
const kSendFileQueue = Symbol("sendFileQueue");
const kReadStateVersion = Symbol("readStateVersion");
const kReadStateCommand = Symbol("readStateCommand");
const kReadStatePutStream = Symbol("readStatePutStream");
const kReadStateDone = Symbol("readStateDone");

class CommandProcessor extends Transform {
    constructor(clientStreamProcessor, cache) {
        super();
        this[kSource] = clientStreamProcessor;
        this[kCache] = cache;
        this[kSendFileQueue] = async.queue(this._sendFile.bind(this), 1);
        this._readState = kReadStateVersion;
        this._trx = null;
        this._putStream = null;
        this._putSize = 0;
        this._putSent = 0;
    }

    _transform(chunk, encoding, callback) {
        var handler = null;
        var self = this;

        switch(this._readState) {
            case kReadStateVersion:
                handler = this._handleVersion;
                break;
            case kReadStateCommand:
                handler = this._handleCommand;
                break;
            case kReadStatePutStream:
                handler = this._handleWrite;
                break;
            case kReadStateDone:
                return callback(null);
                break;
        }

        handler.call(this, chunk, function(err) {
            if(err) {
                self._quit(err);
            }

            callback();
        });
    }

    _quit(err) {
        this[kSendFileQueue].kill();
        this[kSource].unpipe(this);
        this[kSource].emit('quit');
        this._readState = kReadStateDone;
        err && helpers.log(consts.LOG_ERR, err);
    }

    _sendFile(task, callback) {
        var self = this;

        this[kCache].getFileStream(task.type, task.guid, task.hash, function(err, result) {
            if(err || result === null) {
                self.push('-i');
                self.push(task.guid);
                self.push(task.hash);
            }
            else {
                self.push('+i');
                self.push(helpers.encodeInt64(result.size));
                self.push(task.guid);
                self.push(task.hash);

                result.stream
                    .on('readable', function() {
                        var chunk;
                        while((chunk = result.stream.read()) != null) {
                            self.push(chunk);
                        }
                    })
                    .on('end', function() {
                        callback(null);
                    })
                    .on('error', function(err) {
                        callback(err);
                    });
            }
        });
    }
    
    _handleVersion(data, callback) {
        var version = helpers.readUInt32(data);
        this._readState = kReadStateCommand;
        this.push(helpers.encodeInt32(version));

        if(version !== consts.PROTOCOL_VERSION) {
            version = 0;
            callback(new Error("Bad Client protocol version"));
        }
        else {
            callback(null);
        }
    }

    _handleWrite(data, callback) {
        var self = this;
        
        this._putStream.write(data, 'ascii', function() {
            self._putSent += data.length;
            if(self._putSent === self._putSize) {
                self._readState = kReadStateCommand;
                self._putSent = 0;
                self._putSize = 0;
            }

            callback();
        });
    }

    _handleCommand(data, callback) {
        var cmd, size, type, guid, hash = null;
        if(data.length > 1) {
            cmd = data.slice(0, 2).toString('ascii');
            type = cmd[1];

            if (data.length === 2 + consts.ID_SIZE) {
                guid = Buffer.from(data.slice(2, 2 + consts.GUID_SIZE));
                hash = Buffer.from(data.slice(2 + consts.HASH_SIZE));
            }
            else if (data.length === 2 + consts.SIZE_SIZE) {
                size = helpers.readUInt64(data.slice(2));
            }
        }
        else if(data.length > 0) {
            cmd = data.toString('ascii');
        }
        else {
            return callback();
        }

        switch(cmd) {
            case 'q':
                this._quit();
                this._readState = kReadStateDone;
                break;
            case 'ga':
            case 'gi':
            case 'gr':
                this._onGet(type, guid, hash, callback);
                break;
            case 'ts':
                this._onTransactionStart(guid, hash, callback);
                break;
            case 'te':
                this._onTransactionEnd(callback);
                break;
            case 'pa':
            case 'pi':
            case 'pr':
                this._onPut(type, size, callback);
                break;
            case 'icf':
                this._onIntegrityCheck(true, callback);
                break;
            case 'icv':
                this._onIntegrityCheck(false, callback);
                break;
            default:
                callback(new Error("Unrecognized command '" + cmd + "'"));
        }
    }

    _onGet(type, guid, hash, callback) {
        this[kSendFileQueue].push({
            type: type,
            guid: guid,
            hash: hash
        });

        callback(null);
    }

    _onTransactionStart(guid, hash, callback) {
        var self = this;

        if(this._trx !== null) {
            return callback(new Error("Already in a transaction"));
        }

        this[kCache].createPutTransaction(guid, hash, function(err, trx) {
            if(err) {
                return callback(err);
            }

            self._trx = trx;
            callback(null);
        });
    }

    _onTransactionEnd(callback) {
        var self = this;

        if(!this._trx) {
            return callback(new Error("Not in a transaction"));
        }

        this[kCache].endPutTransaction(this._trx, function(err) {
            self._trx = null;
            callback(err);
        });
    }

    _onPut(type, size, callback) {
        var self = this;

        if(!this._trx) {
            return callback(new Error("Not in a transaction"));
        }

        this._trx.getWriteStream(type, size, function(err, stream) {
            if(err) {
                return callback(err);
            }

            self._putStream = stream;
            self._putSize = size;
            self._readState = kReadStatePutStream;
            callback(null);
        });
    }

    _onIntegrityCheck(doFix, callback) {
        var self = this;

        this[kCache].integrityCheck(doFix, function(err, numErrs) {
            if(err) {
                return callback(err);
            }

            self.push('ic');
            self.push(helpers.encodeInt64(numErrs));
            callback(null);
        })
    }
}

module.exports = CommandProcessor;