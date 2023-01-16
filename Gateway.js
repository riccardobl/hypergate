import Peer from "./Peer.js";
import Message from "./Message.js";
import HyperDHT from '@hyperswarm/dht';
import Hyperswarm from 'hyperswarm';
import Net from 'net';
import Crypto from 'crypto';
import Sodium from 'sodium-universal';
import b4a from 'b4a';
import UDPNet from './UDPNet.js';
import Utils from "./Utils.js";
import HttpApi from "./HttpApi.js";
export default class Gateway extends Peer{
    constructor(secret,listenOnAddr,gateTransformer,opts){   
        super(secret,true,opts);

        this.routingTable={};
        this.gateways={};
        this.listenOnAddr=listenOnAddr;
        this.gateTransformer=gateTransformer;
        // listen for new routes
        this.addMessageHandler((peer,msg)=>{
            console.log(msg);

            if (msg.actionId == Message.actions().advRoutes) {
                const routes=msg.routes;
                console.log("Receiving routes from "+peer.info.publicKey.toString("hex"),routes)

                this._mergeRoutingTableFragment(routes,peer.info.publicKey);
            }  
            return false;
        });
        this.refresh();

        
    }
    startHttpApi(on){
        super.startHttpApi(on);
        this.httpApi.register("/routingTable",(url,body)=>{
            return this.routingTable;
        });
        this.httpApi.register("/gates",(url,body)=>{
            return Object.values(this.gateways).map(g=>g.gate);
        });
    }

    // merge routes
    _mergeRoutingTableFragment(routingTableFragment, peerKey){
        const routeExpiration=Date.now()+1000*60; // 1 minute
        for (const gatePort in routingTableFragment){
            if (!this.routingTable[gatePort]){
                this.routingTable[gatePort]={
                    routes: [],
                    i:0
                };
            }
            for(const route of routingTableFragment[gatePort]){
                route.route=peerKey;

                let updatedRoute=this.routingTable[gatePort].routes.find(r=>r.route.equals(route.route));
                if(!updatedRoute){
                    updatedRoute=route;
                    this.routingTable[gatePort].routes.push(updatedRoute);
                }
                updatedRoute.routeExpiration=routeExpiration;
                 
            }
        }
        console.log("Update routing table",JSON.stringify(this.routingTable));
    }

    // find a route
    _getRoute(gatePort){
        const t=this.routingTable[gatePort];
        if(!t)return undefined;
        while(true){
            if(!t.routes.length)return undefined;
            if(t.i>=t.routes.length)t.i=0;
            const route=t.routes[t.i++];
            if(!route) throw "Undefined route??";
            if (route.routeExpiration<Date.now()){
                t.routes.splice(t.i-1,1);
                continue;
            }
            return route.route;
        }
    }


    _getNextChannel(){
        const increment=()=>{
            this._nextChannelId++;
            if( this._nextChannelId>4294967295) this._nextChannelId=1;
        }
        if(!this._usedChannels) this._usedChannels=new Set();;
        if(!this._nextChannelId) this._nextChannelId=1;
        else increment();

        while( this._channels&& this._usedChannels.has(this._nextChannelId)){
            increment();
        }

        this._usedChannels.add( this._nextChannelId);
        return  this._nextChannelId;
    }

    _releaseChannel(channelId){
        if(!this._usedChannels) this._usedChannels=new Set();
        this._usedChannels.delete(channelId);
    }

    // open a new gate
    _openGate(gatePort){

        const onConnection =  (gate,gateway,socket)=>{ 
            // on incoming connection, create a channel
            const channelPort=this._getNextChannel();
            console.log('Create channel',channelPort,'on gate',gatePort);
            const channel={
                // protocol:protocol,
                socket:socket,
                route:undefined,
                buffer:[],
                duration: 1000*60,
                expire:Date.now()+1000*60,
                // gatePort:gatePort,
                gate:gate,
                alive:true
            };

            // store channels in gateway object
            if(!gateway.channels)gateway.channels={};
            gateway.channels[channelPort]=channel;
            
            // pipe data to route
            channel.pipeData=(data)=>{
                // reset expiration everytime data is piped
                channel.expire=Date.now()+channel.duration;

                // pipe
                if(channel.route){ // if route established
                    if(channel.buffer.length>0){
                        while(channel.buffer.length>0){
                            const buffered=channel.buffer.shift();
                            this.send(channel.route,Message.create(Message.actions().stream,{
                                channelPort:channelPort,
                                data:buffered
                            }));
                        }
                    }
                    if(data){
                        this.send(channel.route,Message.create(Message.actions().stream,{
                            channelPort:channelPort,
                            data:data
                        }));
                    }
                }else{ // if still waiting for a route, buffer
                    if(data)channel.buffer.push(data);
                }
            }      

            // close route (bidirectional)
            channel.close = () => {
                
                try {
                    if (channel.route) {
                        this.send(channel.route, Message.create(Message.actions().close, {
                            channelPort: channelPort
                        }));
                    }
                } catch (e) {
                    console.error(e);
                }
                try {
                    socket.end();
                } catch (e) {
                    console.error(e);
                }
                channel.alive=false;
                delete gateway.channels[channelPort];
                this._releaseChannel(channelPort);
            };
            
            // timeout channel
            const timeout=()=>{
                if(!channel.alive)return;
                try{
                    if(channel.expire<Date.now()){
                        console.log("Channel expired!");
                        channel.close();
                    }
                }catch(e){
                    console.error(e);
                }
                setTimeout(timeout,1000*60);
            };
            timeout();

            // pipe gate actions to route
            socket.on("data",channel.pipeData);         
            socket.on("close",channel.close);
            socket.on("end",channel.close);
            socket.on("error",channel.close);

            // look for a route
            const findRoute=async()=>{
                console.log("Looking for route");
                while(true){
                    const route=this._getRoute(gatePort);
                    if(!route) { // no route: kill channel
                        channel.close();
                        break; 
                    }

                    // send open request and wait for response
                    try{
                        await new Promise((res,rej)=>{
                            console.log("Test route",b4a.toString(route,"hex"));
                            this.send(route,Message.create(Message.actions().open,{
                                channelPort:channelPort,
                                gatePort:gatePort                            
                            }));
                            const timeout=setTimeout(()=>rej("timeout"),5000); // timeout open request
                            this.addMessageHandler((peer,msg)=>{
                                if(msg.actionId==Message.actions().open&& msg.channelPort==channelPort){
                                    
                                    if(msg.error){
                                        console.log("Received error",msg.error);
                                        rej(msg.error);
                                        return true; // error, detach
                                    }
                                    console.log("Received confirmation");
                                    channel.route=route;
                                    channel.accepted=true;
                                    clearTimeout(timeout);
                                    res();         
                                    return true; // detach listener                    
                                }
                                return !channel.alive; // detach when channel dies
                            });
                            
                        });

                        // found a route
                        console.info(
                            "New gate channel opened:",channelPort," tot: ",Object.keys(gateway.channels).length, gate.protocol,
                            "\nInitiated from ", socket.remoteAddress,":",socket.remotePort,
                            "\n  To",socket.localAddress,":",socket.localPort);
                        

                        // pipe route data to gate
                        this.addMessageHandler((peer,msg)=>{
                            // everytime data is piped, reset expiration
                            channel.expire=Date.now()+channel.duration;

                            // pipe
                            if(msg.actionId==Message.actions().stream&& msg.channelPort==channelPort){
                                socket.write(msg.data);
                                return false; // detach listener
                            }else if(msg.actionId==Message.actions().close&& 
                                (msg.channelPort==channelPort||msg.channelPort<=0 /* close all */)
                            ){
                                channel.close();
                                return true; // detach listener
                            }
                            return !channel.alive; // detach when channel dies
                        });                    

                        // pipe pending buffered data
                        channel.pipeData();

                        // exit route finding mode, now everything is ready
                        break;
                    }catch(e){
                        console.error(e);
                        new Promise((res,rej)=>setTimeout(res,100)); // wait 100 ms
                    }                
                }

            };
            findRoute();
        }

        let gate = Utils.computeGate(gatePort);
        if (this.gateTransformer) {
            gate = this.gateTransformer(gate);
        }
        // const [port,isUDP]=resolveGate(gatePort);
        // let isUDP=gatePort<0;
        // let port=Math.abs(gatePort);

        // if(this.portTransformer){
        //     const filterResult=this.portFilter(port,isUDP);
        //     if(typeof filterResult=="number"){
        //         port=filterResult;
        //     }else{
        //         if(!filterResult){
        //             port=undefined;
        //         }
        //     }
        // }

        // let gateway;
        // if(port){
        if (gate) {
            const gateway = (gate.protocol == "udp" ? UDPNet : Net).createServer((socket) => {
                onConnection(gate, gateway, socket);
            });
            gateway.listen(gate.port, this.listenOnAddr,()=>{
                if(gate.port==0){
                    gate.port=gateway.address().port;
                }
            });
        
            gateway.gate=gate;
            //register
            console.info("Opened new gate", gate.gate, "on", this.listenOnAddr + ":" + gate.port, "with protocol", gate.protocol);
            return gateway;
        }else{
            console.log("Ignore gate", gatePort, ". Filtered");
        }
        return undefined;
        // }

        // return gateway;
    }

    // resolveGate(v){
        
    
    //     let out=undefined;
    //     // if(typeof v=="string"){ // it's an alias or translated port
    //     let port = 0;
    //     let isUDP = v.endsWith("/udp");
    //     v = v.split("/")[0];
    //     out = { gate: v, port: port, isUDP: isUDP };
    //     translatePort(out);
    //     // }else{
    //         // out= {gate:v,port:Math.abs(v), isUDP:v<0};
    //     // }
    //     if(this.gateTransformer){
    //         out=this.gateTransformer(out);
    //     }
    //     return out;
    // }
    
    async refresh(){
        if(this.stopped)return;
        super.refresh();
        this.refreshing=true;
        // if(this.routingTable){
            const refreshedGateways={};
            for(const [gatePort, t] of Object.entries(this.routingTable)){
                try{
                    if(this.gateways[gatePort]){
                        refreshedGateways[gatePort]=this.gateways[gatePort];
                        continue;
                    }
                    const gateway=this._openGate(gatePort);//t.protocol);
                    if(gateway) refreshedGateways[gatePort]=gateway;
                }catch(e){
                    console.error(e);
                }
            }

            for(const gatePort in this.gateways){
                if(!refreshedGateways[gatePort]){
                    const gateway=this.gateways[gatePort];
                    for(const channel of Object.values(gateway.channels)){
                        await channel.close();
                    }
                    await gateway.close();
                }
            }
        // }

        this.gateways=refreshedGateways;
        this.refreshing=false;
    }


    
//     async onAuthorizedMessage(c, peer, msg) {
//         if(this.isGate){
//             if (msg.actionId == Message.actions().advRoutes) {
//                 const routes=msg.routes;
//                 this._mergeRoutingTableFragment(routes,peer.publicKey);
//             }
//         }else{
//             if (msg.actionId == Message.actions().advRoutes) {
//                 const routes=msg.routes;
//                 this._mergeRoutingTableFragment(routes,peer.publicKey);
//             }else if(msg.actionId == Message.actions().open){
//                 // open connection to service
//                 const gatePort=msg.gatePort;
//                 const service=this.getService(gatePort);
//                 if(!service){
//                     console.error("service not found");
//                     c.write(Message.create(Message.actions().open, {channelPort:msg.channelPort,error:"Service "+gatePort+" not found"}));
//                     return;
//                 }

//                 const serviceConn=Net.connect({
//                     host: service.serviceHost,
//                     port: service.servicePort,
//                     allowHalfOpen: true
//                 });

//                 serviceConn.on("data", data => {
//                     c.write(Message.create(Message.actions().stream, {
//                         channelPort:msg.channelPort,
//                         data:data
//                     }));
//                 });

//                 serviceConn.on("error", (err) => {
//                     console.error(err);
//                 });

//                 serviceConn.on("close",()=>{
//                     c.write(Message.create(Message.actions().close, {
//                         channelPort:msg.channelPort
//                     }));
//                     peer.removeChannel(msg.channelPort);

//                 });

                
//                 peer.addChannel(msg.channelPort, serviceConn);
                
//             }else if(msg.actionId == Message.actions().stream){
//                 const channel=peer.getChannel(msg.channelPort);
//                 if(channel){
//                     channel.write(msg.data);
//                 }
//             }  else if(msg.actionId == Message.actions().close){
//                 const channel=peer.getChannel(msg.channelPort);
//                 if(channel){
//                     channel.end();
//                 }
//             }
//         }
//     }
}
    