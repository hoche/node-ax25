var util    = require("util"),
    events    = require("events"),
    ax25    = require("./index.js");

// Magic numbers for state.connection
var DISCONNECTED     = 1,
    CONNECTED         = 2,
    CONNECTING         = 3,
    DISCONNECTING     = 4;

var Session = function(args) {

    var self = this;
    events.EventEmitter.call(this);

    var settings = {
        'maxFrames' : 4,
        'packetLength' : 256,
        'retries' : 5,
        'hBaud' : 1200,
        'modulo128' : false
    };

    var properties = {
        'remoteCallsign' : "",
        'remoteSSID' : 0,
        'localCallsign' : "",
        'localSSID' : 0,
        'repeaterPath' : []
    };

    var state = {
        'initialized' : false,
        'connection' : DISCONNECTED,
        'receiveSequence' : 0,
        'sendSequence' : 0,
        'remoteReceiveSequence' : 0,
        'remoteBusy' : false,
        'sentREJ' : false,
        'sentSREJ' : false,
        'gotREJSequenceNum' : -1,
        'gotSREJSequenceNum' : -1,
        'sendBuffer' : [],
        'receiveBuffer' : []
    };

    var timers = {
        'connect' : {
            'event' : undefined,
            'attempts' : 0,
            'getTimeout' : function () { return getTimeout(); },
            'callback' : function() { self.connect(); }
        },
        'disconnect' : {
            'event' : undefined,
            'attempts' : 0,
            'getTimeout' : function () { return getTimeout(); },
            'callback' : function() { self.disconnect(); }
        },
        // Sent I-frame Acknowlegement Timer (6.7.1.3 and 4.4.5.1). This is started when a single
        // I frame is sent, or when the last I-frame in a sequence of I-frames is sent. This is
        // cleared by the reception of an acknowledgement for the I-frame (or by the link being
        // reset). If this timer expires, we follow 6.4.11 - we're supposed to send an RR/RNR with
        // the P-bit set and then restart the timer. After N attempts, we reset the link.
        't1' : {
            'event' : undefined,
            'attempts' : 0,
            'getTimeout' : function () { return getTimeout(); },
            'callback' : function() {
                if (timers.t1.attempts == settings.retries) {
                    clearTimer("t1");
                    self.connect();
                    return;
                }
                timers.t1.attempts++;
                sendRR(true);
                // leave the timer running
            }
        },
        // Response Delay Timer (6.7.1.2). This is started when an I-frame is received. If
        // subsequent I-frames are received, the timer should be restarted. When it expires
        // an RR for the received data can be sent or an I-frame if there are any new packets
        // to send.
        't2' : {
            'event' : undefined,
            'attempts' : 0,
            'getTimeout' : function () {
                console.log("Starting t2 timer");
                return (getMaxPacketTime() * 2);
            },
            'callback' : function() {
                console.log("DING: t2 timer expired");
                clearTimer("t2");
                drain();
            }
        },
        // Poll Timer (6.7.1.3 and 4.4.5.2). This is started when T1 is not running (there are
        // no outstanding I-frames). When it times out and RR or RNR should be transmitted
        // and T1 started.
        't3' : {
            'event' : undefined,
            'attempts' : 0,
            'getTimeout' : function () {
                return (getTimeout() * 7);
            },
            'callback' : function() {
                if (typeof timers.t1.event != "undefined")
                    return;
                if (timers.t3.attempts == settings.retries) {
                    clearTimer("t3");
                    self.disconnect();
                    return;
                }
            }
        }
    };

    this.__defineGetter__(
        "connected",
        function() {
            if(state.connection == CONNECTED)
                return true;
            else
                return false;
        }
    );

    this.__defineGetter__(
        "connection",
        function() {
            return state.connection;
        }
    );

    this.__defineGetter__(
        "localCallsign",
        function() {
            return properties.localCallsign;
        }
    );

    this.__defineSetter__(
        "localCallsign",
        function(value) {
            if(!ax25.Utils.testCallsign(value))
                self.emit("error", "ax25.Session.localCallsign: Invalid callsign.");
            if(state.connection != DISCONNECTED)
                self.emit("error", "ax25.Session: Addresses cannot be changed unless disconnected.");
            properties.localCallsign = value;
        }
    );

    this.__defineGetter__(
        "localSSID",
        function() {
            return properties.localSSID;
        }
    );

    this.__defineSetter__(
        "localSSID",
        function(value) {
            if(typeof value != "number" || value < 0 || value > 15)
                self.emit("error", "ax25.Session.localSSID: Invalid SSID.");
            if(state.connection != DISCONNECTED)
                self.emit("error", "ax25.Session: Addresses cannot be changed unless disconnected.");
            properties.localSSID = value;
        }
    );

    this.__defineGetter__(
        "remoteCallsign",
        function() {
            return properties.remoteCallsign;
        }
    );

    this.__defineSetter__(
        "remoteCallsign",
        function(value) {
            if(!ax25.Utils.testCallsign(value))
                self.emit("error", "ax25.Session.remoteCallsign: Invalid callsign.");
            if(state.connection != DISCONNECTED)
                self.emit("error", "ax25.Session: Addresses cannot be changed unless disconnected.");
            properties.remoteCallsign = value;
        }
    );

    this.__defineGetter__(
        "remoteSSID",
        function() {
            return properties.remoteSSID;
        }
    );

    this.__defineSetter__(
        "remoteSSID",
        function(value) {
            if(typeof value != "number" || value < 0 || value > 15)
                self.emit("error", "ax25.Session.remoteSSID: Invalid SSID.");
            if(state.connection != DISCONNECTED)
                self.emit("error", "ax25.Session: Addresses cannot be changed unless disconnected.");
            properties.remoteSSID = value;
        }
    );

    this.__defineGetter__(
        "repeaterPath",
        function() {
            return properties.repeaterPath;
        }
    );

    this.__defineSetter__(
        "repeaterPath",
        function(value) {
            if(!Array.isArray(value))
                self.emit("error", "ax25.Session.repeaterPath must be an array.");
            for(var r = 0; r < value.length; r++) {
                if(    typeof value[r] != "object"
                    ||
                    typeof value[r].callsign != "string"
                    ||
                    typeof value[r].ssid != "number"
                    ||
                    !ax25.Utils.testCallsign(value[r].callsign)
                    ||
                    value[r].ssid < 0
                    ||
                    value[r].ssid > 15
                ) {
                    self.emit(
                        "error",
                        "ax25.Session.repeaterPath: elements must be { 'callsign', 'ssid' } objects."
                    );
                }
            }
            properties.repeaterPath = value;
        }
    );

    this.__defineGetter__(
        "maxFrames",
        function() {
            return settings.maxFrames;
        }
    );

    this.__defineSetter__(
        "maxFrames",
        function(value) {
            if(typeof value != "number" || value < 1 || value > ((settings.modulo128) ? 127 : 7)) {
                self.emit(
                    "error",
                    "ax25.Session.maxFrames must be a number from 1 through "
                    + (settings.modulo128) ? 127 : 7 + "."
                );
            }
            settings.maxFrames = value;
        }
    );

    this.__defineGetter__(
        "packetLength",
        function() {
            return settings.packetLength;
        }
    );

    this.__defineSetter__(
        "packetLength",
        function(value) {
            if(typeof value != "number" || value < 1)
                self.emit("error", "ax25.Session.packetLength must be a number >= 1.");
            settings.packetLength = value;
        }
    );

    this.__defineGetter__(
        "retries",
        function() {
            return settings.retries;
        }
    );

    this.__defineSetter__(
        "retries",
        function(value) {
            if(typeof value != "number" || value < 1)
                self.emit("error", "ax25.Session.retries must be a number >= 1.");
            settings.retries = value;
        }
    );

    this.__defineGetter__(
        "hBaud",
        function() {
            return settings.hBaud;
        }
    );

    this.__defineSetter__(
        "hBaud",
        function(value) {
            if(typeof value != "number" || value < 1)
                self.emit("error", "ax25.Session.hBaud must be a number >= 1.");
            settings.hBaud = value;
        }
    );

    this.__defineGetter__(
        "modulo128",
        function() {
            return settings.modulo128;
        }
    );

    this.__defineSetter__(
        "modulo128",
        function(value) {
            if(typeof value != "boolean")
                self.emit("error", "ax25.Session.modulo128 must be boolean.");
            settings.modulo128 = value;
        }
    );

    this.__defineGetter__(
        "sendBufferLength",
        function() {
            return state.sendBuffer.length;
        }
    );

    this.__defineGetter__(
        "receiveBufferLength",
        function() {
            return state.receiveBuffer.length;
        }
    );

    var emitPacket = function(packet) {
        if(typeof packet == "undefined" || !(packet instanceof ax25.Packet)) {
            self.emit(
                "error",
                "ax25.Session: Private function 'emitPacket' - invalid packet."
            );
            return;
        }
        self.emit("packet",    packet);
    }

    // Milliseconds required to transmit the largest possible packet
    var getMaxPacketTime = function() {
        return Math.floor(
            (    (    (    // Flag + Address + Control + FCS + Flag <= 600 bits
                        600
                        // Maximum possible information field length in bits
                        + (settings.packetLength * 8)
                    // HLDC bits-per-second rate
                    ) / settings.hBaud
                )
                // To milliseconds
                * 1000
            )
        ); // Rounded down
    }

    var getTimeout = function() {
        var multiplier = 0;
        for (var p = 0; p < state.sendBuffer.length; p++) {
            if(!state.sendBuffer.sent)
                continue;
            multiplier++;
        }
        return    (
            (    (    // ms required to transmit largest possible packet
                    getMaxPacketTime()
                    // The number of hops from local to remote
                    * Math.max(1, properties.repeaterPath.length)
                // Twice the amount of time for a round-trip
                ) * 4
            )
            /*    This isn't great, but we need to give the TNC time to
                finish transmitting any packets we've sent to it before we
                can reasonably start expecting a response from the remote
                side.  A large settings.maxFrames value coupled with a
                large number of sent but unacknowledged frames could lead
                to a very long interval. */
            + (getMaxPacketTime() * Math.max(1, multiplier))
        );
    }

    var setTimer = function(timerName) {
        // clear anything currently running
        if (typeof timers[timerName].event != "undefined")
            clearTimer(timerName);
        
        // set the timer
        var interval = timers[timerName].getTimeout();
        timers[timerName].event = setInterval(
            timers[timerName].callback,
            interval
        );
    }

    var clearTimer = function(timerName) {
        if (typeof timers[timerName].event != "undefined") {
            clearInterval(timers[timerName].event);
            timers[timerName].event = undefined;
        }
        
        timers[timerName].attempts = 0;
    }

    var receiveAcknowledgement = function(packet) {
        
        // first, scan the sent packets. If it's a packet we've already
        // sent and it's earlier than the incoming packet's NR count,
        // it was received and we can discard it.
        for (var p = 0; p < state.sendBuffer.length; p++) {
            if (state.sendBuffer[p].sent
                &&
                state.sendBuffer[p].ns != packet.nr
                &&
                ax25.Utils.distanceBetween(
                    packet.nr,
                    state.sendBuffer[p].ns,
                    ((settings.modulo128) ? 128 : 8)
                ) <= settings.maxFrames
            ) {
                // remove the packet
                state.sendBuffer.splice(p, 1);
                p--;
            }
        }
        
        // set the current receive to the received packet's NR count
        state.remoteReceiveSequence = packet.nr;
    }

    var sendRR = function(pollFinal) {
        emitPacket(
            new ax25.Packet(
                {    'destinationCallsign'    : properties.remoteCallsign,
                    'destinationSSID'        : properties.remoteSSID,
                    'sourceCallsign'        : properties.localCallsign,
                    'sourceSSID'            : properties.localSSID,
                    'repeaterPath'            : properties.repeaterPath,
                    'nr'                    : state.receiveSequence,
                    'ns'                    : state.sendSequence,
                    'pollFinal'                : pollFinal,
                    'command'                 : true,
                    'type'                    : ax25.Defs.S_FRAME_RR
                }
            )
        );
    }

    // Send the packets in the out queue.
    //
    // If the REJ sequence number is set, we resend outstanding
    // packets and any new packets (up to maxFrames)
    //
    // Otherwise, we just send new packets (up to maxFrames)
    var drain = function() {
        if (state.remoteBusy) {
            clearTimer("t1"); // t3 will poll and wake us up
            return;
        }
        
        var sequenceNum = state.sendSequence;
        if (state.gotREJSequenceNum > 0) {
            sequenceNum = state.gotREJSequenceNum;
        }

        var startTimer = false;
        for (var packet = 0; packet < state.sendBuffer.length; packet++) {
            if (ax25.Utils.distanceBetween(
                    sequenceNum,
                    state.remoteReceiveSequence,
                    ((settings.modulo128) ? 128 : 8)
                ) < settings.maxFrames
            ) {
                state.sendBuffer[packet].nr = state.receiveSequence;
                if (!state.sendBuffer[packet].sent) {
                    state.sendBuffer[packet].ns = state.sendSequence;
                    state.sendBuffer[packet].sent = true;
                    state.sendSequence = (state.sendSequence + 1) % ((settings.modulo128) ? 128 : 8);
                }
                startTimer = true;
                emitPacket(state.sendBuffer[packet]);
                
                sequenceNum = (sequenceNum + 1) % ((settings.modulo128) ? 128 : 8);
            }
        }
        
        // if we have no rejects but we have nothing new to send, just send an RR
        if ((state.gotREJSequenceNum < 0) && !startTimer) {
            sendRR(false);
            startTimer = true;
        }
        
        // reset the REJ sequence number
        state.gotREJSequenceNum = -1;
        
        if (startTimer)
            setTimer("t1");
    }

    var renumber = function() {
        for (var p = 0; p < state.sendBuffer.length; p++) {
            state.sendBuffer[p].ns = p % ((settings.modulo128) ? 128 : 8);
            state.sendBuffer[p].nr = 0;
            state.sendBuffer[p].sent = false;
        }
    }

    this.connect = function() {

        if (!state.initialized) {
            if (properties.remoteCallsign.length > 0 && properties.remoteSSID > 0
               && properties.localCallsign.length > 0 && properties.localSSID > 0) {
                state.initialized = true;
            } else {
                self.emit(
                    "error",
                    "ax25.Session.connect: localCallsign and remoteCallsign not set."
                );
               
            }
        }

        state.connection = CONNECTING;
        state.receiveSequence = 0;
        state.sendSequence = 0;
        state.remoteReceiveSequence = 0;
        state.remoteBusy = false;
        
        state.gotREJSequenceNum = -1;

        clearTimer("disconnect");
        clearTimer("t3");

        emitPacket(
            new ax25.Packet(
                {    'destinationCallsign'    : properties.remoteCallsign,
                    'destinationSSID'        : properties.remoteSSID,
                    'sourceCallsign'        : properties.localCallsign,
                    'sourceSSID'            : properties.localSSID,
                    'repeaterPath'            : properties.repeaterPath,
                    'nr'                    : state.receiveSequence,
                    'ns'                    : state.sendSequence,
                    'pollFinal'                : true,
                    'command'                 : true,
                    'type'                    : 
                        (settings.modulo128) ? ax25.Defs.U_FRAME_SABME : ax25.Defs.U_FRAME_SABM
                }
            )
        );

        renumber();

        timers.connect.attempts++;
        if (timers.connect.attempts == settings.retries) {
            clearTimer("connect");
            state.connection = DISCONNECTED;
            return;
        }
        if (typeof timers.connect.event == "undefined")
            setTimer("connect");

    }

    this.disconnect = function() {

        clearTimer('connect');
        clearTimer('t1');
        clearTimer('t2');
        clearTimer('t3');

        if (state.connection != 2) {
            self.emit("error", "ax25.Session.disconnect: Not connected.");
            state.connection = 1;
            clearTimer('disconnect');
            return;
        }

        if (timers.disconnect.attempts == settings.retries) {
            clearTimer('disconnect');
            emitPacket(
                new ax25.Packet(
                    {    'destinationCallsign'    : properties.remoteCallsign,
                        'destinationSSID'        : properties.remoteSSID,
                        'sourceCallsign'        : properties.localCallsign,
                        'sourceSSID'            : properties.localSSID,
                        'repeaterPath'            : properties.repeaterPath,
                        'nr'                    : state.receiveSequence,
                        'ns'                    : state.sendSequence,
                        'pollFinal'                : false,
                        'command'                 : false,
                        'type'                    : ax25.Defs.U_FRAME_DM
                    }
                )
            );
            state.connection = DISCONNECTED;
            return;
        }

        timers.disconnect.attempts++;
        state.connection = DISCONNECTING;
        emitPacket(
            new ax25.Packet(
                {    'destinationCallsign'    : properties.remoteCallsign,
                    'destinationSSID'        : properties.remoteSSID,
                    'sourceCallsign'        : properties.localCallsign,
                    'sourceSSID'            : properties.localSSID,
                    'repeaterPath'            : properties.repeaterPath,
                    'nr'                    : state.receiveSequence,
                    'ns'                    : state.sendSequence,
                    'pollFinal'                : true,
                    'command'                 : true,
                    'type'                    : ax25.Defs.U_FRAME_DISC
                }
            )
        );
        if (typeof timers.disconnect.event == "undefined")
            setTimer("disconnect");

    }

    // Add a new packet to our send queue.
    // 
    // If the t2 timer is not running, we can just send all the packets.
    // If the t2 timer is running, we need to wait for it to expire, then
    // we can send them.
    this.send = function(info) {
        if (!Array.isArray(info))
            this.emit("error", "ax25.Session.send: Argument must be an array.");
        while(info.length > 0) {
            state.sendBuffer.push(
                new ax25.Packet(
                    {    'destinationCallsign'    : properties.remoteCallsign,
                        'destinationSSID'        : properties.remoteSSID,
                        'sourceCallsign'        : properties.localCallsign,
                        'sourceSSID'            : properties.localSSID,
                        'repeaterPath'            : properties.repeaterPath,
                        'pollFinal'                : false,
                        'command'                 : true,
                        'type'                    : ax25.Defs.I_FRAME,
                        'info'                    : info.splice(0, settings.packetLength)
                    }
                )
            );
        }
        
        if (typeof timers.t2.event == "undefined") {
            drain();
        }
        
        return;
    }

    this.sendString = function(str) {
        if (typeof str != "string")
            this.emit("error", "ax25.Session.sendString: Argument must be a string.");
        if (str.length < 1)
            this.emit("error", "ax25.Session.sendString: Argument of zero length.");
        this.send(ax25.Utils.stringToByteArray(str));
    }

    this.receive = function(packet) {

        if (!state.initialized) {
            properties.remoteCallsign = packet.sourceCallsign;
            properties.remoteSSID = packet.sourceSSID;
            properties.localCallsign = packet.destinationCallsign;
            properties.localSSID = packet.destinationSSID;
            state.initialized = true;
        }

        properties.repeaterPath = [];
        for (var r = packet.repeaterPath.length - 1; r >= 0; r--) {
            // Drop any packet that was meant for a repeater and not us
            if(packet.repeaterPath[r].ssid&ax25.Defs.A_CRH == 0)
                return false;
            packet.repeaterPath[r].ssid|=(0<<7);
            properties.repeaterPath.push(packet.repeaterPath[r]);
        }

        var response = new ax25.Packet(
            {    'destinationCallsign'    : properties.remoteCallsign,
                'destinationSSID'        : properties.remoteSSID,
                'sourceCallsign'        : properties.localCallsign,
                'sourceSSID'            : properties.localSSID,
                'repeaterPath'            : properties.repeaterPath,
                'nr'                    : state.receiveSequence,
                'ns'                    : state.sendSequence,
                'pollFinal'                : false,
                'command'                : (packet.command) ? false : true
            }
        );

        var emit = [];

        switch (packet.type) {
        
            // Set Asynchronous Balanced Mode, aka Connect in 8-frame mode (4.3.3.1)
            case ax25.Defs.U_FRAME_SABM:
                state.connection = CONNECTED;
                state.receiveSequence = 0;
                state.sendSequence = 0;
                state.remoteReceiveSequence = 0;
                state.gotREJSequenceNum = -1;
                state.remoteBusy = false;
                clearTimer("connect");
                clearTimer("disconnect");
                clearTimer("t1");
                clearTimer("t2");  // may want to set this instead
                clearTimer("t3");
                settings.modulo128 = false;
                renumber();
                emit = ["connection", true];
                response.type = ax25.Defs.U_FRAME_UA;
                if (packet.command && packet.pollFinal)
                    response.pollFinal = true;
                break;

            // Connect Extended (128-frame mode) (4.3.3.2)
            case ax25.Defs.U_FRAME_SABME:
                state.connection = CONNECTED;
                state.receiveSequence = 0;
                state.sendSequence = 0;
                state.remoteReceiveSequence = 0;
                state.gotREJSequenceNum = -1;
                state.remoteBusy = false;
                clearTimer("connect");
                clearTimer("disconnect");
                clearTimer("t1");
                clearTimer("t2");  // may want to set this instead
                clearTimer("t3");
                settings.modulo128 = true;
                renumber();
                emit = ["connection", true];
                response.type = ax25.Defs.U_FRAME_UA;
                if (packet.command && packet.pollFinal)
                    response.pollFinal = true;
                break;

            // Disconnect (4.3.3.3). This is fairly straightforward.
            // If we're connected, reset our state, send a disconnect message,
            // and let the upper layer know the remote disconnected.
            // If we're not connected, reply with a WTF? (DM) message.
            case ax25.Defs.U_FRAME_DISC:
                if (state.connection == CONNECTED) {
                    state.connection = DISCONNECTED;
                    state.receiveSequence = 0;
                    state.sendSequence = 0;
                    state.remoteReceiveSequence = 0;
                    state.gotREJSequenceNum = -1;
                    state.remoteBusy = false;
                    state.sendBuffer = [];
                    state.receiveBuffer = [];
                    clearTimer("connect");
                    clearTimer("disconnect");
                    clearTimer("t1");
                    clearTimer("t2");
                    clearTimer("t3");
                    response.type = ax25.Defs.U_FRAME_UA;
                    // emit the disconnect message right away
                    this.emit("connection", false);
                } else {
                    response.type = ax25.Defs.U_FRAME_DM;
                    response.pollFinal = true;
                }
                // send a reply and return right away.
                emitPacket(response);
                return;
                
            // Unnumbered Acknowledge (4.3.3.4). We get this in response to
            // SABM(E) packets and DISC packets. It's not clear what's supposed
            // to happen if we get this when we're in another state. Right now
            // if we're connected, we ignore it.
            case ax25.Defs.U_FRAME_UA:
                if(state.connection == CONNECTING) {
                    // finish the connect
                    state.connection = CONNECTED;
                    clearTimer("connect");
                    clearTimer("t2");
                    setTimer("t3");
                    response = false;
                    // emit a new connection message
                    emit = ["connection", true];
                } else if (state.connection == DISCONNECTING) {
                    // finish the disconnect
                    state.connection = DISCONNECTED;
                    clearTimer("disconnect");
                    clearTimer("t2");
                    clearTimer("t3");
                    response = false;
                    emit = ["connection", false];
                } else if (state.connection == CONNECTED) {
                    // ignore it.
                    //this.connect();
                    response = false;
                } else {
                    // we're disconnected and got a UA. Send a Disconnected Mode response. (4.3.3.5)
                    response.type = ax25.Defs.U_FRAME_DM;
                    response.pollFinal = false;
                }
                break;
            
            // Disconnected Mode (4.3.3.5).
            // If we're connected and we get this, the remote hasn't gone through the whole connection
            // process. It probably missed part of the connection frames or something. So...start all
            // over and retry the connecection.
            // If we think we're in the middle of setting up a connection and get this, something got
            // out of sync with the remote and it's confused - maybe it didn't hear a disconnect we
            // we sent, or it's replying to a SABM saying it's too busy. If we're trying to disconnect
            // and we get this, everything's cool. Either way, we transition to disconnected mode.
            // If we get this when we're unconnected, we send a WTF? (DM) message as a reply.
            case ax25.Defs.U_FRAME_DM:
                if (state.connection == CONNECTED) {
                    this.connect();
                    response = false;
                } else if(state.connection == CONNECTING || state.connection == DISCONNECTING) {
                    state.connection = DISCONNECTED;
                    state.receiveSequence = 0;
                    state.sendSequence = 0;
                    state.remoteReceiveSequence = 0;
                    state.gotREJSequenceNum = -1;
                    state.remoteBusy = false;
                    state.sendBuffer = [];
                    state.receiveBuffer = [];
                    clearTimer("connect");
                    clearTimer("disconnect");
                    clearTimer("t1");
                    clearTimer("t2");
                    clearTimer("t3");
                    response = false;
                    if(state.connection == CONNECTING) {
                        settings.modulo128 = false;
                        this.connect();
                    }
                    emit = ["connection", false];
                } else {
                    response.type = ax25.Defs.U_FRAME_DM;
                    response.pollFinal = true;
                }
                break;
        
            // Unnumbered Information (4.3.3.6). We send this to the upper layer as an out-of-band UI packet, but
            // if the pollfinal flag is set internally we fabricate a response for it.
            //
            // XXX handle "uidata" at upper layer - make note of this in the docs
            case ax25.Defs.U_FRAME_UI:
                emit = ["uidata", packet.info];
                if (packet.pollFinal) {
                    response.pollFinal = false;
                    response.type = (state.connection == CONNECTED) ? ax25.Defs.S_FRAME_RR : ax25.Defs.U_FRAME_DM;
                } else {
                    response = false;
                }
                break;

            // Exchange Identification (4.3.3.7). Placeholder pending XID implementation
            case ax25.Defs.U_FRAME_XID:
                response.type = ax25.Defs.U_FRAME_DM;
                break;

            // Test (4.3.3.8). Send a test response right away.
            case ax25.Defs.U_FRAME_TEST:
                response.type = ax25.Defs.U_FRAME_TEST;
                if(packet.info.length > 0)
                    response.info = packet.info;
                break;
            
            // Frame Recovery message. (4.3.3.9). This was removed from the AX25 standard, and if we
            // get one we're just supposed to reset the link.
            case ax25.Defs.U_FRAME_FRMR:
                if(state.connection == CONNECTING && settings.modulo128) {
                    settings.modulo128 = false;
                    this.connect();
                    response = false;
                } else if(state.connection == CONNECTED) {
                    this.connect();
                    response = false;
                } else {
                    response.type = ax25.Defs.U_FRAME_DM;
                    response.pollFinal = true;
                }
                break;
            
            // Receive Ready (4.3.2.1)
            // Update our counts and handle any connection status changes (pollFinal).
            // Get ready to do a drain by starting the t2 timer. If we get more RR's
            // or IFRAMES, we'll have to reset the t2 timer. 
            case ax25.Defs.S_FRAME_RR:
                if(state.connection == CONNECTED) {
                    state.remoteBusy = false;
                    if (packet.command && packet.pollFinal) {
                        response.type = ax25.Defs.S_FRAME_RR;
                        response.pollFinal = true;
                    } else {
                        response = false;
                    }
                    receiveAcknowledgement(packet);
                    setTimer("t2");
                } else if (packet.command) {
                    response.type = ax25.Defs.U_FRAME_DM;
                    response.pollFinal = true;
                }
                break;
            
            // Receive Not Ready (4.3.2.2)
            // Just update our counts and handle any connection status changes (pollFinal).
            // Don't send a reply or any data, and clear the t2 timer in case we're about
            // to send some. (Subsequent received packets may restart the t2 timer.)
            // 
            // XXX (Not sure on this) We also need to restart the T1 timer because we
            // probably got this as a reject of an I-frame.
            case ax25.Defs.S_FRAME_RNR:
                if(state.connection == CONNECTED) {
                    state.remoteBusy = true;
                    receiveAcknowledgement(packet);
                    if (packet.command && packet.pollFinal) {
                        response.type = ax25.Defs.S_FRAME_RR;
                        response.pollFinal = true;
                    } else {
                        response = false;
                    }
                    clearTimer("t2");
                    setTimer("t1");
                } else if(packet.command) {
                    response.type = ax25.Defs.U_FRAME_DM;
                    response.pollFinal = true;
                }
                break;
            
            // Reject (4.3.2.3). The remote rejected a single connected frame, which means
            // it got something out of order.
            // Leave T1 alone, as this will trigger a resend
            // Set T2, in case we get more data from the remote soon.
            case ax25.Defs.S_FRAME_REJ:
                if(state.connection == CONNECTED) {
                    state.remoteBusy = false;
                    if(packet.command && packet.pollFinal) {
                        response.type = ax25.Defs.S_FRAME_RR;
                        response.pollFinal = true;
                    } else {
                        response = false;
                    }
                    receiveAcknowledgement(packet);
                    state.gotREJSequenceNum = packet.nr;
                    setTimer("t2");
                } else {
                    response.type = ax25.Defs.U_FRAME_DM;
                    response.pollFinal = true;
                }
                break;
            
            // Information (4.3.1). This is our data packet.
            case ax25.Defs.I_FRAME:
                if(state.connection == CONNECTED) {
                    if (packet.pollFinal)
                        response.pollFinal = true;
                    if (packet.ns == state.receiveSequence) {
                        state.sentREJ = false;
                        state.receiveSequence =
                            (state.receiveSequence + 1)
                            %
                            ((settings.modulo128) ? 128 : 8);
                        emit = ["data", packet.info];
                    } else if (state.sentREJ) {
                        response = false;
                    } else if (!state.sentREJ) {
                        // XXX not sure if we want to send this right away.
                        // Right now we'll fall through and start the t2 timer.
                        // Is that the correct thing to do?
                        response.type = ax25.Defs.S_FRAME_REJ;
                        state.sentREJ = true;
                    }
                    receiveAcknowledgement(packet);
                    
                    // if we have no response, or if the current response isn't the final one,
                    // don't send anything right now and start timer t2
                    if (!response || !response.pollFinal) {
                        response = false;
                        setTimer("t2");                       
                    }
                } else if (packet.command) {
                    response.type = ax25.Defs.U_FRAME_DM;
                    response.pollFinal = true;
                }
                break;
                
            default:
                response = false;
                break;
                
        }

        if (response instanceof ax25.Packet)
            emitPacket(response);

        if (emit.length == 2)
            this.emit(emit[0], emit[1]);

    }

}
util.inherits(Session, events.EventEmitter);

module.exports = Session;
