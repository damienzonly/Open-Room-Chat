import React, { Component } from "react";
import Dashboard from "./components/Dashboard";
import { BrowserRouter as Router, Route, Switch } from "react-router-dom";
import ChangeUsername from "./components/ChangeUsername";
import _ from "lodash";

let mqtt = require("mqtt");

const DISCOVERY_INTERVAL = 500;
const ONLINE_CHECK_INTERVAL = 2000;
const PURGE_INTERVAL = 5000;
const DASHBOARD_HEIGHT = 500;
const HANDLE_PEOPLE_FN_INTERVAL = 1000;

const username = process.env.REACT_APP_USERNAME || "";
const password = process.env.REACT_APP_PASSWORD || "";

const credentials = username && password ? { username, password } : {};
const brokerUrl = process.env.REACT_APP_BROKER_URL || "";
const brokerPort = process.env.REACT_APP_BROKER_PORT || "";
const brokerPath = process.env.REACT_APP_BROKER_PATH || "";

class ChatApp extends Component {
    constructor(props) {
        super(props);
        this.state = {
            account: "user " + Math.floor(Math.random() * 1000),
            currentRoom: "global",
            currentMessage: "",
            rooms: {
                global: {
                    messages: [
                        {
                            text: "Welcome to the IRC chat",
                            sender: "default-account",
                            time: new Date()
                        }
                    ],
                    members: {}
                }
            }
        };
        this.discoveries = {};
    }

    addMessageToRoom = (message, room) => {
        if (message.text.match(/^\s*$/)) return;
        message.text = message.text.trim();
        this.setState(state => {
            // clone currentRoom instead of reference
            room = room || `${state.currentRoom}`;
            let nextRoom = this.getRoomClone(room);
            if (!nextRoom) {
                console.error("couldn't not find room", room);
                return;
            }
            nextRoom.messages = [
                ...nextRoom.messages,
                {
                    text: message.text,
                    sender: message.sender,
                    time: new Date()
                }
            ];
            return {
                rooms: {
                    ...state.rooms,
                    [room]: nextRoom
                }
            };
        }, this.scrollMessagesToBottom);
    };

    changeAccountName = name => {
        if (name === "") return;
        if (name === this.state.account) return;
        let room = this.getRoomClone(this.state.currentRoom);
        if (name in room.members) {
            console.error(`Username "${name}" already exists`);
            return;
        }
        this.setState({ account: name });
    };

    handleOnlinePeople = () => {
        setInterval(() => {
            this.setState(state => {
                let rooms = _.cloneDeep(state.rooms);
                for (const room in rooms) {
                    let members = rooms[room].members;
                    for (const member in members) {
                        let last_seen = members[member].last_seen;
                        let now = Date.now();
                        let time_passed = now - last_seen;
                        if (time_passed < ONLINE_CHECK_INTERVAL) {
                            members[member].online = true;
                        } else if (time_passed > PURGE_INTERVAL) {
                            delete members[member];
                        } else {
                            members[member].online = false;
                        }
                    }
                }
                return {
                    rooms
                };
            });
        }, HANDLE_PEOPLE_FN_INTERVAL);
    };
    componentWillMount = () => {
        // initialize mqtt
        this.client = mqtt.connect("ws://" + brokerUrl, {
            port: brokerPort,
            path: brokerPath,
            ...credentials
        });
        this.client
            .on("connect", () => {
                console.debug("Connected");
                for (const room of Object.keys(this.state.rooms)) {
                    this.tuneToRoom(room);
                    console.log(`tuned to room/${room}`);
                    this.sendDiscovery(room, DISCOVERY_INTERVAL);
                }
            })
            .on("error", err => {
                if (err) console.error(err);
            })
            .on("message", (topic, packet) => {
                try {
                    packet = JSON.parse(packet);
                    if (topic.match(/\w+\/discovery$/)) {
                        // create room and add user
                        if (packet.room in this.state.rooms) {
                            // new member connected, update my members list
                            this.addMemberToRoom(packet, packet.room);
                        } else {
                            // someone else is spamming into another room
                            this.tuneToRoom(packet.room);
                            this.setState(state => {
                                return {
                                    rooms: {
                                        ...state.rooms,
                                        [packet.room]: {
                                            members: {},
                                            messages: []
                                        }
                                    }
                                };
                            });
                        }
                        return;
                    }
                    if (packet.sender === this.state.account) return;
                    this.addMessageToRoom(packet, topic.substr("room/".length));
                } catch (e) {
                    console.error(e);
                }
            });
        this.client.subscribe(`room/+/discovery`);
        this.handleOnlinePeople();
    };

    sendDiscovery = (room, interval) => {
        let intv = setInterval(() => {
            this.client.publish(
                `room/${room}/discovery`,
                JSON.stringify({
                    account: this.state.account,
                    room: this.state.currentRoom,
                    last_seen: Date.now(),
                    online: true
                })
            );
            this.discoveries = {
                ...this.discoveries,
                [room]: intv
            };
        }, interval);
    };

    addMemberToRoom = (payload, room) => {
        let nextRoom = this.getRoomClone(room);
        let roomMembers = Object.keys(nextRoom.members);
        if (roomMembers.indexOf(payload) !== -1) return;
        nextRoom.members = {
            ...nextRoom.members,
            [payload.account]: payload
        };
        this.setState(state => {
            return {
                rooms: {
                    ...state.rooms,
                    [room]: nextRoom
                }
            };
        });
    };

    openRoom = nextRoomName => {
        if (!nextRoomName) return;
        if (this.state.currentRoom === nextRoomName) {
            this.scrollMessagesToBottom();
            this.focusTextArea();
            return;
        }
        this.tuneToRoom(nextRoomName);
        this.setState(state => {
            clearInterval(this.discoveries[state.currentRoom]);
            let room = this.getRoomClone(state.currentRoom);
            let nextRoom = this.getRoomClone(nextRoomName);
            if (!nextRoom) return;
            if (nextRoom.members.hasOwnProperty(state.account)) {
                console.error("A user named", state.account, "");
                return {};
            }
            delete this.discoveries[state.currentRoom];
            delete room.members[state.account];
            return {
                rooms: {
                    ...state.rooms,
                    // remove immediately myself from the current room
                    [state.currentRoom]: room,
                    // update the room i'm entering in
                    [nextRoomName]: nextRoom
                },
                currentRoom: nextRoomName
            };
        });
        this.sendDiscovery(nextRoomName, DISCOVERY_INTERVAL);
        setImmediate(() => {
            this.scrollMessagesToBottom();
            this.resetDraft();
            this.focusTextArea();
        });
    };

    resetDraft = () => {
        this.setState({ currentMessage: "" });
    };

    focusTextArea = () => {
        document.getElementById("message-field").focus();
    };

    scrollMessagesToBottom = () => {
        let g = document.getElementById("messages-list");
        g.scrollTop = g.scrollHeight;
    };

    tuneToRoom = room => {
        this.client.subscribe(`room/${room}`);
    };

    addRoom = room => {
        if (room.match(/\s+/)) {
            console.error("room names must not contain whitespaces");
            return;
        }
        this.setState(
            state => {
                if (!room) return;
                if (this.state.rooms.hasOwnProperty(room)) return;
                this.tuneToRoom(room);
                return {
                    rooms: {
                        ...state.rooms,
                        [room]: {
                            messages: [],
                            members: {}
                        }
                    }
                };
            },
            () => {
                this.openRoom(room);
            }
        );
    };

    /**
     * Returns the room associated with "room"
     * you SHOULD NOT prepend "room/" before this parameter
     */
    getRoomClone = room => (this.state.rooms.hasOwnProperty(room) ? _.cloneDeep(this.state.rooms[room]) : null);

    getCurrentRoom = () => {
        return _.cloneDeep(this.state.rooms[this.state.currentRoom]);
    };

    sendDraft = () => {
        this.addMessageToRoom({
            sender: this.state.account,
            text: this.state.currentMessage
        });
        setImmediate(() => {
            this.client.publish(
                `room/${this.state.currentRoom}`,
                JSON.stringify({
                    sender: this.state.account,
                    text: this.state.currentMessage
                })
            );
            this.setState({
                currentMessage: ""
            });
        });
    };
    changeDraft = draft => {
        this.setState({
            currentMessage: draft
        });
    };

    render() {
        return (
            <Router>
                <Switch>
                    <Route exact path="/">
                        <Dashboard
                            account={this.state.account}
                            rooms={this.state.rooms}
                            openRoom={this.openRoom}
                            addRoom={this.addRoom}
                            currentRoom={this.state.currentRoom}
                            getCurrentRoom={this.getCurrentRoom}
                            currentRoomName={this.state.currentRoom}
                            currentMessage={this.state.currentMessage}
                            changeDraft={this.changeDraft}
                            sendDraft={this.sendDraft}
                            displayHeight={DASHBOARD_HEIGHT}
                        />
                    </Route>
                    <Route
                        exact
                        path="/account-name"
                        render={p => (
                            <ChangeUsername
                                {...p}
                                account={this.state.account}
                                changeAccountName={this.changeAccountName}
                            />
                        )}
                    />
                </Switch>
            </Router>
        );
    }
}

export default ChatApp;
