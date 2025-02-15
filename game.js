// vim: tw=120 softtabstop=4 shiftwidth=4

let sprintf = require('sprintf-js').sprintf;

let Bot = require('./bot').Bot;
let decodeMoves = require('./bot').decodeMoves;
let move2gtpvertex = require('./bot').move2gtpvertex;
let console = require('./console').console;
let config = require('./config');

/**********/
/** Game **/
/**********/
class Game {
    constructor(conn, game_id) { /* {{{ */
        this.conn = conn;
        this.game_id = game_id;
        this.socket = conn.socket;
        this.state = null;
        this.opponent_evenodd = null;
        this.greeted = false;
        this.connected = true;
        this.bot = null;
        this.bot_failures = 0;
        this.my_color = null;
        this.corr_move_pending = false;
        this.processing = false;
        this.handicap_moves = [];    // Handicap stones waiting to be sent when bot is playing black.
        this.disconnect_timeout = null;

        this.scheduleRetry = this.scheduleRetry.bind(this);

        this.log("Connecting to game.");

        // TODO: Command line options to allow undo?
        //
        this.socket.on('game/' + game_id + '/undo_requested', (undodata) => {
            this.log("Undo requested", JSON.stringify(undodata, null, 4));
        });

        this.socket.on('game/' + game_id + '/gamedata', (gamedata) => {
            if (!this.connected) return;

            //this.log("Gamedata:", JSON.stringify(gamedata, null, 4));

            let prev_phase = (this.state ? this.state.phase : null);
            this.state = gamedata;
            this.my_color = this.conn.bot_id === this.state.players.black.id ? "black" : "white";
            this.log("gamedata     " + this.header());

            this.conn.addGameForPlayer(gamedata.game_id, this.getOpponent().id);

            // Only call game over handler if game really just finished.
            // For some reason we get connected to already finished games once in a while ...
            if (gamedata.phase === 'finished' && prev_phase && gamedata.phase !== prev_phase)
                this.gameOver();

            // First handicap is just lower komi, more handicaps may change who is even or odd move #s.
            //
            if (this.state.free_handicap_placement && this.state.handicap > 1) {
                //In Chinese, black makes multiple free moves.
                //
                this.opponent_evenodd = this.my_color === "black" ? 0 : 1;
                this.opponent_evenodd = (this.opponent_evenodd + this.state.handicap - 1) % 2;
            } else if (this.state.handicap > 1) {
                // In Japanese, white makes the first move.
                //
                this.opponent_evenodd = this.my_color === "black" ? 1 : 0;
            } else {
                // If the game has a handicap, it can't be a fork and the above code works fine.
                // If the game has no handicap, it's either a normal game or a fork. Forks may have reversed turn ordering.
                //
                if (this.state.clock.current_player === this.conn.bot_id) {
                    this.opponent_evenodd = this.state.moves.length % 2;
                } else {
                    this.opponent_evenodd = (this.state.moves.length + 1) % 2;
                }
            }

            // If server has issues it might send us a new gamedata packet and not a move event. We could try to
            // check if we're missing a move and send it to bot out of gamedata. For now as a safe fallback just
            // restart the bot by killing it here if another gamedata comes in. There normally should only be one
            // before we process any moves, and makeMove() is where a new Bot is created.
            //
            let gamedataChanged = (JSON.stringify(this.state) !== JSON.stringify(gamedata));

            if (this.bot && gamedataChanged) {
                this.log("Killing bot because of gamedata change after bot was started");

                if (config.DEBUG) {
                    this.log('Previously seen gamedata:', this.state);
                    this.log('New gamedata:', gamedata);
                }

                this.ensureBotKilled();

                if (this.processing) {
                    this.processing = false;
                    --Game.moves_processing;
                    if (config.corrqueue && this.state.time_control.speed === "correspondence") {
                        --Game.corr_moves_processing;
                    }
                }
            }

            // active_game isn't handling this for us any more. If it is our move, call makeMove.
            //
            if (this.state.phase === "play" && this.state.clock.current_player === this.conn.bot_id) {
                if (config.corrqueue && this.state.time_control.speed === "correspondence" && Game.corr_moves_processing > 0) {
                    this.corr_move_pending = true;
                } else {
                    if (!this.bot || !this.processing) this.makeMove(this.state.moves.length);
                }
            }
        });

        this.socket.on('game/' + game_id + '/clock', (clock) => {
            if (!this.connected) return;
            if (config.DEBUG) this.log("clock:", JSON.stringify(clock));

            if (config.nopause && !config.nopauseranked && !config.nopauseunranked 
                && clock.pause && clock.pause.paused && clock.pause.pause_control
                && !clock.pause.pause_control["stone-removal"] && !clock.pause.pause_control.system && !clock.pause.pause_control.weekend
                && !clock.pause.pause_control["vacation-" + clock.black_player_id] && !clock.pause.pause_control["vacation-" + clock.white_player_id]) {
                if (config.DEBUG) this.log("Pausing not allowed. Resuming game.");
                this.resumeGame();
            }

            if (config.nopauseranked && this.state.ranked && clock.pause && clock.pause.paused && clock.pause.pause_control
                && !clock.pause.pause_control["stone-removal"] && !clock.pause.pause_control.system && !clock.pause.pause_control.weekend
                && !clock.pause.pause_control["vacation-" + clock.black_player_id] && !clock.pause.pause_control["vacation-" + clock.white_player_id]) {
                if (config.DEBUG) this.log("Pausing not allowed for ranked games. Resuming game.");
                this.resumeGame();
            }

            if (config.nopauseunranked && (this.state.ranked === false) && clock.pause && clock.pause.paused && clock.pause.pause_control
                && !clock.pause.pause_control["stone-removal"] && !clock.pause.pause_control.system && !clock.pause.pause_control.weekend
                && !clock.pause.pause_control["vacation-" + clock.black_player_id] && !clock.pause.pause_control["vacation-" + clock.white_player_id]) {
                if (config.DEBUG) this.log("Pausing not allowed for unranked games. Resuming game.");
                this.resumeGame();
            }

            //this.log("Clock: ", JSON.stringify(clock));
            if (this.state) {
                this.state.clock = clock;
            } else {
                if (config.DEBUG) console.error("Received clock for " + this.game_id + " but no state exists");
            }

            // Bot only needs updated clock info right before a genmove, and extra communcation would interfere with Leela pondering.
            //if (this.bot) {
            //    this.bot.loadClock(this.state);
            //}
        });
        this.socket.on('game/' + game_id + '/phase', (phase) => {
            if (!this.connected) return;
            this.log("phase", phase)

            //this.log("Move: ", move);
            if (this.state) {
                this.state.phase = phase;
            } else {
                if (config.DEBUG) console.error("Received phase for " + this.game_id + "but no state exists");
            }

            if (phase === 'play') {
                this.scheduleRetry();
            }
        });
        this.socket.on('game/' + game_id + '/move', (move) => {
            if (!this.connected) return;
            if (config.DEBUG) this.log("game/" + game_id + "/move:", move);
            if (!this.state) {
                console.error("Received move for " + this.game_id + "but no state exists");
                // Try to connect again, to get the server to send the gamedata over.
                this.socket.emit('game/connect', this.auth({
                    'game_id': game_id
                }));
                return;
            }
            try {
                this.state.moves.push(move.move);

                // Log opponent moves
                let m = decodeMoves(move.move, this.state.width)[0];
                if ((this.my_color === "white" && (this.state.handicap) >= this.state.moves.length) ||
                    move.move_number % 2 === this.opponent_evenodd)
                    this.log("Got     " + move2gtpvertex(m, this.state.width));
            } catch (e) {
                console.error(e)
            }

            // If we're in free placement handicap phase of the game, make extra moves or wait it out, as appropriate.
            //
            // If handicap === 1, no extra stones are played.
            // If we are black, we played after initial gamedata and so handicap is not < length.
            // If we are white, this.state.moves.length will be 1 and handicap is not < length.
            //
            // If handicap >= 1, we don't check for opponent_evenodd to move on our turns until handicaps are finished.
            //
            if (this.state.free_handicap_placement && (this.state.handicap) > this.state.moves.length) {
                if (this.my_color === "black") {
                    // If we are black, we make extra moves.
                    //
                    this.makeMove(this.state.moves.length);
                } else {
                    // If we are white, we wait for opponent to make extra moves.
                    if (this.bot) this.bot.sendMove(decodeMoves(move.move, this.state.width)[0], this.state.width, this.my_color === "black" ? "white" : "black");
                    if (config.DEBUG) this.log("Waiting for opponent to finish", this.state.handicap - this.state.moves.length, "more handicap moves");
                    if (this.state.moves.length ===1) { // remind once, avoid spamming the reminder
                        this.sendChat("Waiting for opponent to place all handicap stones"); // reminding human player in ingame chat
                    }
                }
            } else {
                if (move.move_number % 2 === this.opponent_evenodd) {
                    // We just got a move from the opponent, so we can move immediately.
                    //
                    if (this.bot) {
                        this.bot.sendMove(decodeMoves(move.move, this.state.width)[0], this.state.width, this.my_color === "black" ? "white" : "black");
                    }

                    if (config.corrqueue && this.state.time_control.speed === "correspondence" && Game.corr_moves_processing > 0) {
                        this.corr_move_pending = true;
                    } else {
                        this.makeMove(this.state.moves.length);
                    }
                    //this.makeMove(this.state.moves.length);
                } else {
                    if (config.DEBUG) this.log("Ignoring our own move", move.move_number);
                }
            }
        });

        this.socket.emit('game/connect', this.auth({
            'game_id': game_id
        }));

        this.connect_timeout = setTimeout(()=>{
            if (!this.state) {
                this.log("No gamedata after 1s, reqesting again");
                this.scheduleRetry();
            }
        }, 1000);
    } /* }}} */

    // Kill the bot, if it is currently running.
    ensureBotKilled() {
        if (this.bot) {
            if (this.bot.failed) {
                this.bot_failures++;
                if (config.DEBUG) {
                    this.log("Observed " + this.bot_failures + " bot failures");
                }
            }
            this.bot.kill();
            this.bot = null;
        }
    }
    // Start the bot.
    ensureBotStarted(eb) { /* {{{ */
        if (this.bot && this.bot.dead) {
            this.ensureBotKilled();
        }

        if (this.bot) return true;

        if (this.bot_failures >= 5) {
            // This bot keeps on failing, give up on the game.
            this.log("Bot has crashed too many times, resigning game");
            this.sendChat("Bot has crashed too many times, resigning game"); // we notify user of this in ingame chat
            this.socket.emit('game/resign', this.auth({
                'game_id': this.game_id
            }));
            if (eb) eb();
            return false;
        }

        this.bot = new Bot(this.conn, this, config.bot_command);
        this.log("Starting new bot process [" + this.bot.pid() + "]");

        this.log("State loading for new bot");
        return this.bot.loadState(this.state, () => {
            if (config.DEBUG) {
                this.log("State loaded for new bot");
            }
        }, eb);
    } /* }}} */

    // Send @cmd to bot and call @cb with returned moves.
    //
    getBotMoves(cmd, cb, eb) { /* {{{ */
        ++Game.moves_processing;
        this.processing = true;
        if (config.corrqueue && this.state.time_control.speed === "correspondence")
            ++Game.corr_moves_processing;

        let doneProcessing = () => {
            this.procesing = false;
            --Game.moves_processing;
            if (config.corrqueue && this.state.time_control.speed === "correspondence") {
                this.corr_move_pending = false;
                --Game.corr_moves_processing;
            }
        };

        let failed = false;
        let botError = (e) => {
            if (failed)  return;

            failed = true;
            doneProcessing();
            this.ensureBotKilled();

            if (eb) eb(e);
        }

        if (!this.ensureBotStarted(botError)) {
            this.log("Failed to start the bot, can not make a move, trying to restart");
            this.sendChat("Failed to start the bot, can not make a move, trying to restart"); // we notify user of this in ingame chat
            return;
        }

        if (config.DEBUG) this.bot.log("Generating move for game", this.game_id);
        this.log(cmd);

        this.bot.getMoves(cmd, this.state, (moves) => {
            doneProcessing();
            cb(moves)

            if (!config.PERSIST && this.bot !== null) {
                this.ensureBotKilled();
            }
        }, botError);
    } /* }}} */

    scheduleRetry() {
        if (config.DEBUG) {
            this.log("Unable to react correctly - re-connect to trigger action based on game state.");
        }
        this.socket.emit('game/disconnect', this.auth({
            'game_id': this.game_id,
        }));
        this.socket.emit('game/connect', this.auth({
            'game_id': this.game_id,
        }));
    }
    // Send move to server.
    // 
    uploadMove(move) { /* {{{ */
        if (move.resign) {
            this.log("Resigning");
            this.socket.emit('game/resign', this.auth({
                'game_id': this.game_id
            }));
            return;
        }

        if (config.DEBUG) this.log("Playing " + move.text, move);
        else this.log("Playing " + move.text);
        this.socket.emit('game/move', this.auth({
            'game_id': this.game_id,
            'move': encodeMove(move)
        }));
        //this.sendChat("Test chat message, my move #" + move_number + " is: " + move.text, move_number, "malkovich");
    } /* }}} */

    // Get move from bot and upload to server.
    // Handle handicap stones with bot as black transparently
    // (we get all of them at once with place_free_handicap).
    //
    makeMove(move_number) { /* {{{ */
        if (config.DEBUG && this.state) { this.log("makeMove", move_number, "is", this.state.moves.length, "!==", move_number, "?"); }
        if (!this.state || this.state.moves.length !== move_number)
            return;
        if (this.state.phase !== 'play')
            return;
        if( config.greeting && !this.greeted && this.state.moves.length < (2 + this.state.handicap) ){
            this.sendChat( config.GREETING, "discussion");
            this.greeted = true;
        }

        let doing_handicap = (this.state.free_handicap_placement && this.state.handicap > 1 &&
            this.state.moves.length < this.state.handicap);

        if (!doing_handicap) {  // Regular genmove ...
            let sendTheMove = (moves) => {  this.uploadMove(moves[0]);  };
            this.getBotMoves("genmove " + this.my_color, sendTheMove, this.scheduleRetry);
            return;
        }

        // Already have handicap stones ? Return next one.
        if (this.handicap_moves.length) {
            this.uploadMove(this.handicap_moves.shift());
            return;
        }

        let warnAndResign = (msg) => {
            this.log(msg);
            this.ensureBotKilled();
            this.uploadMove({'resign': true});
        }

        // Get handicap stones from bot and return first one.
        let storeMoves = (moves) => {
            if (moves.length !== this.state.handicap) {  // Sanity check
                warnAndResign("place_free_handicap returned wrong number of handicap stones, resigning.");
                return;
            }
            for (let i in moves)                     // Sanity check
                if (moves[i].pass || moves[i].x < 0) {
                    warnAndResign("place_free_handicap returned a pass, resigning.");
                    return;
                }

            this.handicap_moves = moves;
            this.uploadMove(this.handicap_moves.shift());
        };

        this.getBotMoves("place_free_handicap " + this.state.handicap, storeMoves, this.scheduleRetry);
    } /* }}} */

    auth(obj) { /* {{{ */
        return this.conn.auth(obj);
    } /* }}} */
    disconnect() { /* {{{ */
        this.conn.removeGameForPlayer(this.game_id);

        if (this.processing) {
            this.processing = false;
            --Game.moves_processing;
            if (config.corrqueue && this.state.time_control.speed === "correspondence") {
                --Game.corr_moves_processing;
            }
        }

        this.ensureBotKilled();

        this.log("Disconnecting from game.");
        this.connected = false;
        this.socket.emit('game/disconnect', this.auth({
            'game_id': this.game_id
        }));
    } /* }}} */
    gameOver() /* {{{ */
    {
        if (config.farewell && this.state)
            this.sendChat(config.FAREWELL, "discussion");

        // Display result
        let s = this.state;
        let col = (s.winner === s.players.black.id ? 'B' : 'W' );
        let res = s.outcome;   res = res[0].toUpperCase() + res.substr(1);
        let m = s.outcome.match(/(.*) points/);
        if (m)  res = m[1];
        if (res === 'Resignation')  res = 'R';
        if (res === 'Cancellation') res = 'Can';
        if (res === 'Timeout')      res = 'Time';
        let winloss = (s.winner === this.conn.bot_id ? "W" : "   L");
        this.log(sprintf("Game over.   Result: %s+%-5s  %s", col, res, winloss));

        if (this.bot) {
            this.bot.gameOver();
            this.ensureBotKilled();
        }

        if (!this.disconnect_timeout) {
            if (config.DEBUG) console.log("Starting disconnect Timeout in Game " + this.game_id + " gameOver()");
            this.disconnect_timeout = setTimeout(() => {  this.conn.disconnectFromGame(this.game_id);  }, 1000);
        }
    } /* }}} */
    header() { /* {{{ */
        if (!this.state)  return;
        let color = 'W  ';  // Playing white against ...
        let player = this.state.players.black;
        if (player.username === config.username) {
            player = this.state.players.white;
            color = '  B';
        }
        let name = player.username;
        let handi = (this.state && this.state.handicap ? "H" + this.state.handicap : "  ");
        return sprintf("%s %s  [%ix%i]  %s", color, name, this.state.width, this.state.width, handi);

        // XXX doesn't work, getting garbage ranks here ...
        // let rank = rankToString(player.rank);
    } /* }}} */
    log() { /* {{{ */
        let moves = (this.state && this.state.moves ? this.state.moves.length : 0);
        let movestr = (moves ? sprintf("Move %-3i", moves) : "        ");
        let arr = [ sprintf("[Game %i]  %s ", this.game_id, movestr) ];

        for (let i=0; i < arguments.length; ++i)
            arr.push(arguments[i]);

        console.log.apply(null, arr);
    } /* }}} */
    sendChat(str, move_number, type = "discussion") {
        if (!this.connected) return;

        this.socket.emit('game/chat', this.auth({
            'game_id': this.game_id,
            'player_id': this.conn.user_id,
            'body': str,
            'move_number': move_number,
            'type': type,
            'username': config.username
        }));
    }
    resumeGame() {
        this.socket.emit('game/resume', this.auth({
            'game_id': this.game_id,
            'player_id': this.conn.bot_id
        }));
    }    
    getOpponent() {
        let player = this.state.players.white;
        if (player.id === this.conn.bot_id)
            player = this.state.players.black;
        return player;
    }
}

function num2char(num) { /* {{{ */
    if (num === -1) return ".";
    return "abcdefghijklmnopqrstuvwxyz"[num];
} /* }}} */
function encodeMove(move) { /* {{{ */
    if (move['x'] === -1) 
        return "..";
    return num2char(move['x']) + num2char(move['y']);
} /* }}} */

Game.moves_processing = 0;
Game.corr_moves_processing = 0;

exports.Game = Game;
