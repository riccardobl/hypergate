export default class Message {
    static actions(){
        return {
            hello: 0, // handshake
            open: 1, // open a channel
            stream: 2, // stream some data from/to a channel
            close: 3, // close a channel
            advRoutes: 4, // advertise peer routes
            


        }
    }

    // static _getActionId(actions){
    //     return this.actions()[actions];
    // }

    // static _getActionForId(actionId){
    //     const actions=this.actions();
    //     for(const action in actions){
    //         if(actions[action]==actionId){
    //             return action;
    //         }
    //     }
    //     return null;
    // }

    static create(actionId, msg) {
        if(!msg)msg={};
        // const actionId=this._getActionId(action);
        if(msg.error){
            const msgErrorBuffer=Buffer.from(JSON.stringify(msg.error), "utf8");
            if(msgErrorBuffer.length>255){
                throw new Error("Error message too long");
            }else if(msgErrorBuffer.length==0){
                throw new Error("Error alias too short");
            }
            const buffer = new Buffer.alloc(1+1+4+msgErrorBuffer.length);
            buffer.writeUInt8(actionId, 0);
            buffer.writeUInt8( msgErrorBuffer.length, 1);
            buffer.writeUInt32BE(msg.channelPort||0, 2);            
            buffer.set(msgErrorBuffer, 1+1+4);
            return buffer;
        }
        const actions=this.actions();

        if (actionId==actions.hello) {
            const buffer = new Buffer.alloc(msg.auth.length+1+1+4);
            buffer.writeUInt8(actionId, 0);
            buffer.writeUInt8(0, 1);
            buffer.writeUInt32BE(msg.isGate?1:0, 2);
            buffer.set(msg.auth, 1+1+4);
            return buffer;
        } else if (actionId==actions.close) {
            const buffer = new Buffer.alloc(4+1+1);
            buffer.writeUInt8(actionId, 0);
            buffer.writeUInt8(0, 1);
            buffer.writeUInt32BE(msg.channelPort, 2);
            return buffer;
        } else if (actionId == actions.stream) {
            const buffer = new Buffer.alloc(msg.data.length + 4+1+1);
            buffer.writeUInt8(actionId, 0);
            buffer.writeUInt8(0, 1);
            buffer.writeUInt32BE(msg.channelPort, 2);
            buffer.set(msg.data, 1+1+4);
            return buffer;
        } else if (actionId==actions.advRoutes) {
            const routes=Buffer.from(JSON.stringify({routes:msg.routes}))
            const buffer = new Buffer.alloc(routes.length + 4+1+1);
            buffer.writeUInt8(actionId, 0);
            buffer.writeUInt8(0, 1);
            buffer.writeUInt32BE(0, 2);
            buffer.set(routes, 1+1+4);
            return buffer;

        } else if (actionId==actions.open) {
            const gatePortBuffer=Buffer.from(msg.gatePort+"", "utf8")
            if(gatePortBuffer.length>255){
                throw new Error("Gate alias too long");
            }else if(gatePortBuffer.length==0){
                throw new Error("Gate alias too short");
            }
            const buffer = new Buffer.alloc(1+1+1+4+gatePortBuffer.length);
            buffer.writeUInt8(actionId, 0);
            buffer.writeUInt8(0, 1);
            buffer.writeUInt32BE(msg.channelPort||0, 2);

            // buffer.writeUInt32BE(msg.channelPort||0, 1+1);
            // let offset=1+1;//+4;
            // if(typeof msg.gatePort == "string"){             
            buffer.writeUInt8(gatePortBuffer.length, 4+2);
            buffer.set(gatePortBuffer, 4+2+1);
            // }else{
            //     buffer.writeUInt8(0, offset);
            //     buffer.writeInt32BE(msg.gatePort, offset+1);
            // }
            return buffer;
    
        } else {
            
            throw new Error("Unknown actionId " + actionId);
        }
    }

   static parse(data) {
        const actionId = data.readUInt8(0);
        const error=data.readUInt8(1);
        const channelPort=data.readUInt32BE(2);
        data=data.slice(2+4);

        if(error){
            return {
                actionId: actionId,
                error: JSON.parse(data.toString("utf8",0,error)),
                channelPort: channelPort
            };
        }

        const actions=this.actions();

        if (actionId == actions.open) { // open
            const length=data.readUInt8(0);
            let gatePort;
            // if(length==0){
            //     gatePort = data.readInt32BE(1);
            // }else{
                gatePort = data.toString("utf8", 1, 1+length);
            // }
            return {
                actionId: actionId,
                gatePort: gatePort,
                channelPort: channelPort
            };
        } else if (actionId == actions.stream) { // stream
            // const a= data.readUInt32BE(1);
             return {
                actionId: actionId,
                channelPort: channelPort,
                data: data
            };
        } else if (actionId == actions.close) { // close
            return {
                actionId: actionId,
                channelPort: channelPort
            };
        } else if (actionId == actions.advRoutes) { // get routing table
            return {
                actionId: actionId,
                routes: JSON.parse(data.toString("utf8")).routes
            };
        } else if (actionId == actions.hello) { // hello
            const isGate=channelPort;
            const auth = data;
            return {
                actionId: actionId,
                auth: auth,
                isGate: isGate==1
            };
        }
    }
}