module.exports = function (RED) {
    "use strict";
    var mqtt = require("mqtt");
    var util = require("util");
    //var isUtf8 = require('is-utf8');

    function RemoteServerNode(n) {
        RED.nodes.createNode(this, n);

        // Configuration options passed by Node Red
        this.broker = n.broker;
        this.port = n.port;
        //this.clientid = n.clientid;
        //this.usetls = n.usetls;

        /*this.verifyservercert = n.verifyservercert;
        this.compatmode = n.compatmode;
        this.keepalive = n.keepalive;
        this.cleansession = n.cleansession;*/

        // Config node state
        this.brokerurl = "";
        /*this.connected = false;
        this.connecting = false;
        this.closing = false;*/
        this.options = {};
        this.queue = [];
        this.subscriptions = {};

        if (n.birthTopic) {
            this.birthMessage = {
                topic: n.birthTopic,
                payload: n.birthPayload || "",
                qos: Number(n.birthQos || 0),
                retain: n.birthRetain == "true" || n.birthRetain === true
            };
        }

        /*if (this.credentials) {
            this.username = this.credentials.user;
            this.password = this.credentials.password;
        }*/

        // If the config node is missing certain options (it was probably deployed prior to an update to the node code),
        // select/generate sensible options for the new fields
        /*if (typeof this.usetls === 'undefined') {
            this.usetls = false;
        }*/
        /*if (typeof this.compatmode === 'undefined') {
            this.compatmode = true;
        }*/
        this.compatmode = true;
        /*if (typeof this.verifyservercert === 'undefined') {
            this.verifyservercert = false;
        }*/
        this.verifyservercert = false;
        /*if (typeof this.keepalive === 'undefined') {
            this.keepalive = 60;
        } else if (typeof this.keepalive === 'string') {
            this.keepalive = Number(this.keepalive);
        }*/
        this.keepalive = 60;
        /*if (typeof this.cleansession === 'undefined') {
            this.cleansession = true;
        }*/
        this.cleansession = true;

        // Create the URL to pass in to the MQTT.js library
        if (this.brokerurl === "") {
            /*if (this.usetls) {
                this.brokerurl = "mqtts://";
            } else {
                this.brokerurl = "mqtt://";
            }*/
            this.brokerurl = "mqtt://";
            if (this.broker !== "") {
                this.brokerurl = this.brokerurl + this.broker + ":" + this.port;
            } else {
                this.brokerurl = this.brokerurl + "localhost:1883";
            }
        }

        if (!this.cleansession && !this.clientid) {
            this.cleansession = true;
            this.warn(RED._("mqtt.errors.nonclean-missingclientid"));
        }

        // Build options for passing to the MQTT.js API
        this.options.clientId = this.clientid || 'mqtt_' + (1 + Math.random() * 4294967295).toString(16);
        /*this.options.username = this.username;
        this.options.password = this.password;*/
        this.options.keepalive = this.keepalive;
        this.options.clean = this.cleansession;
        this.options.reconnectPeriod = RED.settings.mqttReconnectTime || 5000;
        if (this.compatmode == "true" || this.compatmode === true) {
            this.options.protocolId = 'MQIsdp';
            this.options.protocolVersion = 3;
        }
        /*if (this.usetls && n.tls) {
            var tlsNode = RED.nodes.getNode(n.tls);
            if (tlsNode) {
                tlsNode.addTLSOptions(this.options);
            }
        }*/
        // If there's no rejectUnauthorized already, then this could be an
        // old config where this option was provided on the broker node and
        // not the tls node
        if (typeof this.options.rejectUnauthorized === 'undefined') {
            this.options.rejectUnauthorized = (this.verifyservercert == "true" || this.verifyservercert === true);
        }

        if (n.willTopic) {
            this.options.will = {
                topic: n.willTopic,
                payload: n.willPayload || "",
                qos: Number(n.willQos || 0),
                retain: n.willRetain == "true" || n.willRetain === true
            };
        }

        // Define functions called by MQTT in and out nodes
        var node = this;
        this.users = {};

        this.register = function (mqttNode) {
            node.users[mqttNode.id] = mqttNode;
            if (Object.keys(node.users).length === 1) {
                node.connect();
            }
        };

        this.deregister = function (mqttNode, done) {
            delete node.users[mqttNode.id];
            if (node.closing) {
                return done();
            }
            if (Object.keys(node.users).length === 0) {
                if (node.client && node.client.connected) {
                    return node.client.end(done);
                } else {
                    node.client.end();
                    return done();
                }
            }
            done();
        };

        this.connect = function () {
            if (!node.connected && !node.connecting) {
                node.connecting = true;
                node.client = mqtt.connect(node.brokerurl, node.options);
                node.client.setMaxListeners(0);
                // Register successful connect or reconnect handler
                node.client.on('connect', function () {
                    node.connecting = false;
                    node.connected = true;
                    node.log(RED._("mqtt.state.connected", {broker: (node.clientid ? node.clientid + "@" : "") + node.brokerurl}));
                    for (var id in node.users) {
                        if (node.users.hasOwnProperty(id)) {
                            node.users[id].status({
                                fill: "green",
                                shape: "dot",
                                text: "node-red:common.status.connected"
                            });
                        }
                    }
                    // Remove any existing listeners before resubscribing to avoid duplicates in the event of a re-connection
                    node.client.removeAllListeners('message');

                    // Re-subscribe to stored topics
                    for (var s in node.subscriptions) {
                        if (node.subscriptions.hasOwnProperty(s)) {
                            var topic = s;
                            var qos = 0;
                            for (var r in node.subscriptions[s]) {
                                if (node.subscriptions[s].hasOwnProperty(r)) {
                                    qos = Math.max(qos, node.subscriptions[s][r].qos);
                                    node.client.on('message', node.subscriptions[s][r].handler);
                                }
                            }
                            var options = {qos: qos};
                            node.client.subscribe(topic, options);
                        }
                    }

                    // Send any birth message
                    if (node.birthMessage) {
                        node.publish(node.birthMessage);
                    }
                });
                node.client.on("reconnect", function () {
                    for (var id in node.users) {
                        if (node.users.hasOwnProperty(id)) {
                            node.users[id].status({
                                fill: "yellow",
                                shape: "ring",
                                text: "node-red:common.status.connecting"
                            });
                        }
                    }
                })
                // Register disconnect handlers
                node.client.on('close', function () {
                    if (node.connected) {
                        node.connected = false;
                        node.log(RED._("mqtt.state.disconnected", {broker: (node.clientid ? node.clientid + "@" : "") + node.brokerurl}));
                        for (var id in node.users) {
                            if (node.users.hasOwnProperty(id)) {
                                node.users[id].status({
                                    fill: "red",
                                    shape: "ring",
                                    text: "node-red:common.status.disconnected"
                                });
                            }
                        }
                    } else if (node.connecting) {
                        node.log(RED._("mqtt.state.connect-failed", {broker: (node.clientid ? node.clientid + "@" : "") + node.brokerurl}));
                    }
                });

                // Register connect error handler
                node.client.on('error', function (error) {
                    if (node.connecting) {
                        node.client.end();
                        node.connecting = false;
                    }
                });
            }
        };

        this.subscribe = function (topic, qos, callback, ref) {
            ref = ref || 0;
            node.subscriptions[topic] = node.subscriptions[topic] || {};
            var sub = {
                topic: topic,
                qos: qos,
                handler: function (mtopic, mpayload, mpacket) {
                    if (matchTopic(topic, mtopic)) {
                        callback(mtopic, mpayload, mpacket);
                    }
                },
                ref: ref
            };
            node.subscriptions[topic][ref] = sub;
            if (node.connected) {
                node.client.on('message', sub.handler);
                var options = {};
                options.qos = qos;
                node.client.subscribe(topic, options);
            }
        };

        this.unsubscribe = function (topic, ref) {
            ref = ref || 0;
            var sub = node.subscriptions[topic];
            if (sub) {
                if (sub[ref]) {
                    node.client.removeListener('message', sub[ref].handler);
                    delete sub[ref];
                }
                if (Object.keys(sub).length === 0) {
                    delete node.subscriptions[topic];
                    if (node.connected) {
                        node.client.unsubscribe(topic);
                    }
                }
            }
        };

        this.publish = function (msg) {
            if (node.connected) {
                if (!Buffer.isBuffer(msg.payload)) {
                    if (typeof msg.payload === "object") {
                        msg.payload = JSON.stringify(msg.payload);
                    } else if (typeof msg.payload !== "string") {
                        msg.payload = "" + msg.payload;
                    }
                }

                var options = {
                    qos: msg.qos || 0,
                    retain: msg.retain || false
                };
                node.client.publish(msg.topic, msg.payload, options, function (err) {
                    return
                });
            }
        };

        this.on('close', function (done) {
            this.closing = true;
            if (this.connected) {
                this.client.once('close', function () {
                    done();
                });
                this.client.end();
            } else if (this.connecting) {
                node.client.end();
                done();
            } else {
                done();
            }
        });
    }

    RED.nodes.registerType("S_remote-server", RemoteServerNode, {
        /*credentials: {
            user: {type: "text"},
            password: {type: "password"}
        }*/
    });

    function matchTopic(ts, t) {
        if (ts == "#") {
            return true;
        }
        var re = new RegExp("^" + ts.replace(/([\[\]\?\(\)\\\\$\^\*\.|])/g, "\\$1").replace(/\+/g, "[^/]+").replace(/\/#$/, "(\/.*)?") + "$");
        return re.test(t);
    }
};