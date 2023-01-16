import Message from "./Message.js";
import HyperDHT from '@hyperswarm/dht';
import Hyperswarm from 'hyperswarm';
import Net from 'net';
import Crypto from 'crypto';
import Sodium from 'sodium-universal';
import b4a from 'b4a';
import Utils from "./Utils.js";

import HttpApi from "./HttpApi.js";
export default class Peer{
    constructor(secret,isGate,opts){ 
        this.httpApi=new HttpApi();
        this.secret=secret;
        this.isGate=isGate;
        
        // const salt = b4a.alloc(32)
        // Sodium.randombytes_buf_deterministic(salt, Buffer.from(secret,"hex"));   
        // this.routerName = Crypto.scryptSync(secret, salt, 32);
        this.routerKeys=HyperDHT.keyPair(Buffer.from(secret,"hex"));
        
        this._messageHandlers=[];
        this.dht=new HyperDHT(opts);
        this.dht.on("error",(err)=>console.log("DHT error", err));
        this.swarm = new Hyperswarm(this.dht); 
        this.swarm.on("error",(err)=>console.log("Swarm error", err));
        this.swarm.on("connection", (c,peer)=>{
            console.log("Swarm connection", b4a.toString(peer.publicKey,"hex"));
            this.onConnection(c,peer);
        });     

        
       

        this.discovery = this.swarm.join(this.routerKeys.publicKey, { client: true, server: true });
        this.stopped=false;  
        // this.discovery.flushed().then(() => {
            console.info('Joined router:', b4a.toString(this.routerKeys.publicKey, 'hex'))
        // });
    }

 
    startHttpApi(listenOn){
        const {host,port}=Utils.extractHostPort(listenOn);
        this.httpApi.listen(host,port);
    }

    _addAuthorizedPeer(connection, peerInfo){
        if(!this._authorizedPeers)this._authorizedPeers=[];
        const newPeer={
            c:connection,
            info:peerInfo
        }
        this._authorizedPeers.push(newPeer);
        return newPeer;
    }

    _removeAuthorizedPeerByKey(peerKey){
        if(!this._authorizedPeers)return;
        for(let i=0;i<this._authorizedPeers.length;i++){
            const peer=this._authorizedPeers[i];
            if(peer.info.publicKey.equals(peerKey)){
                this._authorizedPeers.splice(i,1);
                return;
            }
        }
    }

    _getAuthorizedPeerByKey(peerKey){
        if(!this._authorizedPeers)return undefined;
        for(const peer of this._authorizedPeers){
            if(peer.info.publicKey.equals(peerKey))return peer;
        }
        return undefined;
    }

    getAuthorizedPeers(){
        return this._authorizedPeers;
    }  

    _createAuthMessage(routerSecret,sourcePublic, targetPublic, routerPublic,timestamp){
        if(!routerSecret||!sourcePublic||!targetPublic||!routerPublic||!timestamp)throw new Error("Invalid authkey");
        const timestampBuffer=Buffer.alloc(1+8);
        timestampBuffer.writeUint8(21,0);
        timestampBuffer.writeBigInt64BE(BigInt(timestamp),1);
        
        // const hmac = Crypto.createHmac("sha512", routerSecret)
        // .update()
        // .digest();        

        const createKey=(source)=>{
            const keyLength=Sodium.crypto_pwhash_BYTES_MAX<Sodium.crypto_generichash_KEYBYTES_MAX?Sodium.crypto_pwhash_BYTES_MAX:Sodium.crypto_generichash_KEYBYTES_MAX;
            if(keyLength<Sodium.crypto_pwhash_BYTES_MIN)throw new Error("Error. Key too short");

            const salt = b4a.alloc(Sodium.crypto_pwhash_SALTBYTES);
            Sodium.crypto_generichash(salt, source);
            // console.log("Create salt",b4a.toString(salt,"hex"));

            const secretKey=b4a.alloc(keyLength);        
            Sodium.crypto_pwhash(secretKey, source, salt, Sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE, Sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE, Sodium.crypto_pwhash_ALG_DEFAULT);
            // console.log("Create key",b4a.toString(secretKey,"hex"));

            return secretKey;
        }

        const hash=(msg,key)=>{
            const enc=b4a.alloc(Sodium.crypto_generichash_BYTES_MAX);
            Sodium.crypto_generichash(enc, msg, key);
            // console.log("Create hash",b4a.toString(enc,"hex"),"Using key",b4a.toString(key,"hex"));
            return enc;
        }
      
        const authMsg=Buffer.concat([sourcePublic, targetPublic, routerPublic, timestampBuffer]);

        const key=createKey(routerSecret);
        if(!key)throw new Error("Error");

        const encAuthMsg=hash(authMsg,key);
        if(!encAuthMsg)throw new Error("Error");


        const out= Buffer.concat([timestampBuffer,encAuthMsg]);    
        if(out.length<32)throw new Error("Invalid authkey");

        return out;
    }

    _getAuthKey(targetPublicKey){
        const sourcePublicKey=this.swarm.keyPair.publicKey;
        // const timestampBuffer=Buffer.alloc(1+8);
        // timestampBuffer.writeUint8(21,0);
        // timestampBuffer.writeBigInt64BE(BigInt(Date.now()),1);
        // const hmac = Crypto.createHmac("sha512", this.routerKeys.secretKey)
        // .update(Buffer.concat([sourcePublicKey, targetPublicKey, this.routerKeys.publicKey, timestampBuffer]))
        // .digest();        
        //  return Buffer.concat([timestampBuffer,hmac]);   
         return this._createAuthMessage(this.routerKeys.secretKey,sourcePublicKey, targetPublicKey, this.routerKeys.publicKey,Date.now()); 
    }

    _verifyAuthKey(sourcePublicKey, authKey){
        const timestampBuffer=authKey.slice(0,8+1);
        const timestamp=timestampBuffer.readBigInt64BE(1);
        const now=BigInt(Date.now());
        if(now-timestamp>1000*60*15){
            console.error("AuthKey expired. Replay attack or clock mismatch?");
            return false;
        }
        const targetPublicKey=this.swarm.keyPair.publicKey;     
        const validAuthMessage=this._createAuthMessage(this.routerKeys.secretKey,sourcePublicKey, targetPublicKey, this.routerKeys.publicKey,Number(timestamp)); 
        return validAuthMessage.equals(authKey);
        // authKey=authKey.slice(8+1);
        // const targetPublicKey=this.swarm.keyPair.publicKey;        
        // const hmac = Crypto.createHmac("sha512",  this.routerKeys.secretKey)
        // .update(Buffer.concat([sourcePublicKey, targetPublicKey,  this.routerKeys.publicKey, timestampBuffer]))
        // .digest();

        // return hmac.equals(authKey);             
    }

    async onConnection(c,peer){
        
        const closeConn = () => {
            const aPeer = this._getAuthorizedPeerByKey(peer.publicKey);
            try {
                if (aPeer) {
                    const msg = Message.create(Message.actions().close, { channelPort: 0 });
                    this.onAuthorizedMessage(aPeer, msg);
                }
            } catch (err) {
                console.error("Error on close", err);
            }
            this._removeAuthorizedPeerByKey(peer.publicKey);            
        };

        c.on("error", (err) =>{
            console.log("Connection error", err)
            closeConn();
        });

        c.on("close",()=>{
            closeConn();
        });

        c.on('data', data => {
            try{
                const msg=Message.parse(data);
                if(msg.actionId==Message.actions().hello){
                    console.log("Receiving handshake");
                    // Only gate->peer or peer->gate connections are allowed
                    if(!this.isGate&&!msg.isGate){
                        peer.ban(true);
                        c.destroy();      
                        console.log("Ban because",b4a.toString(peer.publicKey,"hex") , "is not a gate and tried to connect to a peer",this.isGate,msg.isGate);
                        return;
                    }

                    if(!this._verifyAuthKey(peer.publicKey,msg.auth)){
                        console.error("Authorization failed for peer" ,b4a.toString(peer.publicKey,"hex"),"Ban!");
                        console.log("Authorization failed using authkey ",b4a.toString(msg.auth,"hex"));
                        peer.ban(true);
                        c.destroy();
                        return;
                    }

                    if(this._getAuthorizedPeerByKey(peer.publicKey)){
                        console.error("Already connected??", peer.publicKey);   
                        return;
                    }

                    this._addAuthorizedPeer(c,peer);
                    console.info("Authorized",b4a.toString(peer.publicKey,"hex"));
                    
                
                }else{
                    const aPeer=this._getAuthorizedPeerByKey(peer.publicKey);
                    if(!aPeer){
                        console.error("Unauthorized message from", b4a.toString(peer.publicKey,"hex"));
                        return;
                    }else{
                        this.onAuthorizedMessage(aPeer,msg);
                    }
                } 
            }catch(err){
                console.error("Error on message",err);
            }

        });
        
        const authKey=this._getAuthKey(peer.publicKey);
        // console.log("Attempt authorization with authKey",b4a.toString(authKey,"hex"));
        c.write(Message.create(Message.actions().hello, {
            auth:authKey,
            isGate: this.isGate
        }));
    }   

    async broadcast(msg){
        if(! this._authorizedPeers)return;
        for(const p of this._authorizedPeers){
            this.send(p.info.publicKey,msg)
        }
    }

    async send(peerKey,msg){
        console.log("Sending message to",b4a.toString(peerKey,"hex"));
        const peer=this._getAuthorizedPeerByKey(peerKey);
        
        if(peer)peer.c.write(msg);        
        else console.error("Peer not found");
    }

    addMessageHandler(handler){
        this._messageHandlers.push(handler);
    }

    async onAuthorizedMessage(peer, msg) {
        console.log("Receiving message",msg);
        for(let i=0;i<this._messageHandlers.length;i++){
            const handler=this._messageHandlers[i];
            try{             
                if(handler(peer,msg)){// remove
                    this._messageHandlers.splice(i,1);              
                }
            }catch(err){
                console.error("Error on message handler",err);
            }
        }
    }


    async refresh(){
        if(this.stopped)return;
        this.refreshing=true;
        console.log("Refreshing peers");
        await this.discovery.refresh({
            server: true,
            client: true
        });
        this.refreshing=false;
        setTimeout(()=>this.refresh(), 5000);
    }
    

    async stop(){
        this.stopped=true;
        while(this.refreshing){
            await new Promise(resolve=>setTimeout(resolve,100));
        }
        try{
            this.swarm.destroy();
        }catch(err){
            console.error("Error on stop", err);
        }

        try{
            this.dht.destroy();
        }catch(err){
            console.error("Error on stop", err);
        }
    }

}