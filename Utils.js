import Sodium from 'sodium-universal'
import HyperDHT from '@hyperswarm/dht';
import b4a from 'b4a';

export default class Utils{
    static newSecret() {
        const b = Buffer.alloc(Sodium.randombytes_SEEDBYTES );
        Sodium.randombytes_buf(b) ;
        return b.toString("hex");

    };      


    static getRouterKeys(secret) {
        return HyperDHT.keyPair(Buffer.from(secret,"hex"));
    }

    static getRouterName(secret){
        const keys=Utils.getRouterKeys(secret);
        return b4a.toString(keys.publicKey,"hex");
    }

     static async scanRouter(routerName){
        console.info("Scanning",routerName);
        const node = new HyperDHT();
        const topic=b4a.from(routerName,"hex");
        await node.announce(topic);

        for await (const e of node.lookup(topic)){
            for(const p of e.peers){
                const publicKey=p.publicKey;
                const socket = node.connect(publicKey);
                socket.on('open', function () {
                    if(socket.rawStream){
                        console.info(socket.rawStream.remoteHost );
                    }
                });
                socket.on('connect', function () {
                    if(socket.rawStream){
                        console.info(socket.rawStream.remoteHost );
                    }
                });  
                socket.on("error",(err)=>{
                    if(socket.rawStream){
                        console.info(socket.rawStream.remoteHost );
                    }
                });
            }            
        }
    }

   
    // 8080/udp -> port=8080, protocol=udp
    // 8080 -> port=8080, protocol=tcp
    // 8080/tcp -> port=8080, protocol=tcp
    // 8080:8081/udp -> port=8081, protocol=udp
    // alias:8081/udp -> port=8081, protocol=udp
    static computeGate=(gate)=>{
        const info={gate:gate}
        if(info.gate.indexOf("/")==-1) info.gate+="/tcp";
        const [aliasPort,protocol]=info.gate.split("/");
        const [alias,translatedPort]=aliasPort.split(":");
        if(translatedPort&&!isNaN(translatedPort)){// ???:port/proto
            info.portBind=!isNaN(alias);
            info.port=translatedPort; 
        }else if(!isNaN(alias)) { // port:???/proto || port/proto
            info.portBind=true;
            info.port=alias;
        } else { // alias/proto 
            info.port=0;
            info.portBind=false;
        }
        if(!info.portBind)info.hostProto=alias;
        info.protocol=protocol;      
        return info;
    }

    static isGateAlias=(gate)=>{
        const [alias,translatedPortProtocol]=gate.split(":");
        if(isNaN(alias)) return true;
        return false;
    }



    static extractHostPort(hostPort){
        let port=0;
        let host="127.0.0.1";
        if(!hostPort.toString().indexOf(":")==-1){
            if(typeof hostPort=="number" || !isNaN(hostPort) ){
                port=Number(hostPort);
            }else{
                host=hostPort;
            }
        }else{
            [host,port]=hostPort.split(":");
            if(!isNaN(port)) port=Number(port);
            else port=0;
        }
        return {host,port};
    }
}
