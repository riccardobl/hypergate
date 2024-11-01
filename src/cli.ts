import Minimist from "minimist";
import Utils from "./Utils.js";
import ServiceProvider from "./ServiceProvider.js";
import Gateway from "./Gateway.js";
import Fs from "fs";
import DockerManager from "./DockerManager.js";

function help(argv: string[] = []) {
    const launchCmd = argv[0] + " " + argv[1];
    console.info(`
Usage: ${launchCmd} [options] [router]

Generate a new router:
    ${launchCmd} --new  

Scan a router:
    ${launchCmd} --scan <router>

Start a service provider:
    ${launchCmd} --provider <provider file or json> [--provider <another provider file or json>] --router <router>

Start a service gateway:
    ${launchCmd} --gateway <gateway file or json> --router  <router>

    Gateway options:
        --listen <ip> : Listen on ip (default 127.0.0.1)

Options:
    --help : Show this help               
    --docker [<docker socket path>]: Run in docker mode
    --exposeOnlyPublished: Expose only services that are marked as published (eg. they have a public port in docker)
    --exposeOnlyDocker: Expose only services that are docker containers (default: true if --docker is set)
    --exposeOnlyServices <services>: csv list of services to expose
    --network <network name>: Docker network name
    --image <image name>: Docker image name
    --refreshTime <time in ms>: Refresh time for docker manager
    `);
}

function loadEnvs(argv:any){
    if(!argv.router){
        argv.router = process.env.HYPERGATE_ROUTER;
    }
    if(!argv.gateway){
        argv.gateway = process.env.HYPERGATE_GATEWAY;
    }
    if(!argv.provider){
        argv.provider = process.env.HYPERGATE_PROVIDER;
    }
    if(!argv.docker){
        argv.docker = process.env.HYPERGATE_DOCKER;
    }
    if(!argv.network){
        argv.network = process.env.HYPERGATE_NETWORK;
    }
    if(!argv.image){
        argv.image = process.env.HYPERGATE_IMAGE;
    }
    if(!argv.refreshTime){
        argv.refreshTime = process.env.HYPERGATE_REFRESH_TIME;
    }
    if(!argv.exposeOnlyPublished){
        argv.exposeOnlyPublished = process.env.HYPERGATE_EXPOSE_ONLY_PUBLISHED;
    }
    if(!argv.exposeOnlyDocker){
        argv.exposeOnlyDocker = process.env.HYPERGATE_EXPOSE_ONLY_DOCKER;
    }
    if(!argv.exposeOnlyServices){
        argv.exposeOnlyServices = process.env.HYPERGATE_EXPOSE_ONLY_SERVICES;
    }
    if(!argv.listen){
        argv.listen = process.env.HYPERGATE_LISTEN;
    }
}


async function cli(processArgv: string[]) {
 
    const ctx:any = {};
    const argv = Minimist(processArgv.slice(2));
    loadEnvs(argv);
    if (argv.help) {
        help(processArgv);
    } else {

        const docker = argv.docker;
        const dockerNetwork = argv.network;
        const dockerImage = argv.image;
        const refreshTime = argv.refreshTime;
        const exposeOnlyPublished = argv.exposeOnlyPublished??!!false;
        const exposeOnlyDocker = argv.exposeOnlyDocker??!!docker;
        const exposeOnlyServices = argv.exposeOnlyServices?.split(",")??[];
       
        if(argv.new){
            console.info(Utils.newSecret());
            return;
        }       

        const secret= argv.router
        if(!secret){
            help(processArgv);
            return ctx;
        }
    
        if(argv.scan){
            await Utils.scanRouter(argv.scan??secret);
            return ctx;
        }

        if(argv.provider){
            ctx.serviceProvider = new ServiceProvider(secret);
            
            for(let provider of (Array.isArray(argv.provider)?argv.provider:typeof argv.provider === 'string' ? [argv.provider] : [])){
                provider = argv.provider?.trim()??'';
                if (provider.startsWith("{")||provider.startsWith("[")) {
                    provider = JSON.parse(provider);
                }  else if(provider.startsWith("https://") || provider.startsWith("http://")){
                    provider = await fetch(provider).then((res)=>res.json());
                } else if (Fs.existsSync(provider)) {
                    provider = JSON.parse(Fs.readFileSync(provider).toString());
                } else {
                    throw new Error("Invalid provider "+provider);
                }

                const services = provider.services??provider;
                for(const service of services){
                    const {gatePort, serviceHost, servicePort, protocol, tags} = service;
                    if(
                        !gatePort || !serviceHost || !servicePort
                        || typeof gatePort !== "number" || typeof servicePort !== "number"
                        || typeof serviceHost !== "string" || typeof protocol !== "string"
                        || (tags && typeof tags !== "string")
                    ){
                        console.error("Invalid service", service);
                    } else {                
                        ctx.serviceProvider.addService(gatePort, serviceHost, servicePort, protocol, tags)
                    }
                }       
            }
            if(docker){
                ctx.dockerManagerSP = new DockerManager(
                    ctx.serviceProvider,
                    dockerNetwork,
                    secret,
                    typeof docker === 'string'?docker:undefined,
                    dockerImage,
                    refreshTime
                )
            }
            return ctx;
        }

        if(argv.gateway){
            const listenOn = argv.listen ?? "127.0.0.1";
            let gateway = Array.isArray(argv.gateway)?argv.gateway[0]:argv.gateway;
            gateway = typeof gateway ==='string'?gateway?.trim():undefined;
            if(gateway){
                if (gateway.startsWith("{")||gateway.startsWith("[")) {
                    gateway = JSON.parse(gateway);
                }  else if (gateway.startsWith("https://") || gateway.startsWith("http://")) {
                    gateway = await fetch(gateway).then((res)=>res.json());                
                } else if (Fs.existsSync(gateway)) {
                    gateway = JSON.parse(Fs.readFileSync(gateway).toString());
                } else {
                    throw new Error("Invalid gateway "+gateway);
                }
            }
            const filters = gateway?.services??gateway;
            ctx.serviceGateway = new Gateway(secret, listenOn, async (entry) => {
                if(!filters) return true
                for(const filter of filters){
                    if(filter.gatePort !== undefined && filter.gatePort != entry.gatePort){
                        // console.log("gatePort", filter.gatePort, entry.gatePort)
                        return false;
                    }
                    if(filter.serviceHost !== undefined && filter.serviceHost != entry.serviceHost){
                        // console.log("serviceHost", filter.serviceHost, entry.serviceHost)
                        return false;
                    }
                    if(filter.servicePort !== undefined && filter.servicePort != entry.servicePort){
                        // console.log("servicePort", filter.servicePort, entry.servicePort)
                        return false;
                    }
                    if(filter.protocol !== undefined && filter.protocol != entry.protocol){
                        // console.log("protocol", filter.protocol, entry.protocol)
                        return false;
                    }

                    if(exposeOnlyServices&&exposeOnlyServices.length>0){
                        if(!exposeOnlyServices.includes(entry.serviceHost)) {
                            // console.log("exposeOnlyServices", exposeOnlyServices, entry.serviceHost)
                            return false;
                        }
                    }

                    const entryTags = (entry.tags?.split(" ")??[])
                    if(filter.tags !== undefined){
                        const filterTags = filter.tags.split(" ");
                        if(!filterTags.every((tag:string)=>entryTags.includes(tag))){
                            // console.log/("tags", filter.tags, entryTags)
                            return false;
                        }
                    }
                    if(exposeOnlyDocker){
                        if(!entryTags.includes("docker")) {
                            // console.log("docker", entryTags)
                            return false;
                        }
                    }                    
                    if(exposeOnlyPublished){
                        if(!entryTags.includes("published")) {
                            // console.log("published", entryTags)
                            return false;
                        }
                    }
                }
                return true;
            })
            if(docker){
                ctx.dockerManagerGW = new DockerManager(
                    ctx.serviceGateway,
                    dockerNetwork,
                    secret,
                    typeof docker === 'string'?docker:undefined,
                    dockerImage,
                    refreshTime
                )
            }
            return ctx;
        }

        help(processArgv);
    }
    return ctx;
}


cli(process.argv).then(ctx => {
   process.on('SIGINT', function() {
       
         if(ctx.dockerManagerSP){
            ctx.dockerManagerSP.stop();
        }
        if(ctx.dockerManagerGW){
            ctx.dockerManagerGW.stop();
        }
          if(ctx.serviceProvider){
              ctx.serviceProvider.stop();
         }
         if(ctx.serviceGateway){
              ctx.serviceGateway.stop();
         }
         process.exit();
    });
})