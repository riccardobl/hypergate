
// @ts-ignore
import {Docker} from 'node-docker-api';
import { Service } from './Router.js';
import ServiceProvider from './ServiceProvider.js';
import Gateway from './Gateway.js';

export default class DockerManager {
    private docker: Docker;
    private router: string;
    private image: string;
    private networkName: string;
    private serviceProvider?: ServiceProvider;
    private gateway?: Gateway;
    private refreshTime: number;
    private refreshTimer: any=null;
    private stopped: boolean=false;

    constructor(
        serviceProvider: ServiceProvider | Gateway,
        networkName:string,
        router:string, 
        socketPath?:string,
        image?:string,
        refreshTime?: number
    ){
        this.docker = new Docker({ socketPath: socketPath??'/var/run/docker.sock' });
        this.router = router;
        this.image = image ?? 'hypergate';
        this.networkName = networkName??`hypergate-${router}`;
        this.refreshTime = refreshTime ?? 20*1000;
        if(serviceProvider instanceof ServiceProvider){
            this.serviceProvider = serviceProvider;
        }else if(serviceProvider instanceof Gateway){
            this.gateway = serviceProvider;
        }
        this.loop();
    }

   
    private async getNetwork(){
        let network = (await this.docker.network.list()).find((n:any)=>n.data.Name == this.networkName);
        if(!network){
            network = await this.docker.network.create({
                Name: this.networkName,
                Driver: 'bridge',
                EnableIPv6: false,
            })
        }
        return network;
    }



    public async loop(){
        const services:Array<Service> = await this.getConnectedServices();
        if(this.serviceProvider){
            if(this.serviceProvider){
                for(const service of services){
                    this.serviceProvider.addService(service.gatePort, service.serviceHost, service.servicePort, service.protocol, service.tags)
                }
            }
        }
        if(this.gateway){
            await this.updateDockerGates(services);
        }
        if(this.stopped)return
        this.refreshTimer=setTimeout(()=>this.loop(), this.refreshTime)
    }

    private async updateDockerGates( services:Array<Service>){
        const router = this.router;
        const network = await this.getNetwork();

        const containers = await this.docker.container.list({all:true})
        const servicesXhost:{[host:string]:Array<Service>} = {}
        for(const service of services){
            if(!servicesXhost[service.serviceHost]) servicesXhost[service.serviceHost] = []
            servicesXhost[service.serviceHost].push(service)
        }

        for(const [host, services] of Object.entries(servicesXhost)){
            const gateContainerName=`${host}-hypergate-gateway-${router}`
            let container = containers.find((c:any)=>{
                return c.data.Names[0].substring(1) == gateContainerName
            });
            if(!container){
                const filters = [];
                const ExposedPorts:any = {};
                for(const service of services){
                    ExposedPorts[`${service.servicePort}/${service.protocol}`] = {}
                    filters.push({
                        serviceHost: service.serviceHost,
                    })
                }
                console.info('Creating gateway container', gateContainerName, filters)
                container = await this.docker.container.create({
                    Image: this.image,
                    name: gateContainerName,
                    Env:[`HYPERGATE_ROUTER=${router}`,`HYPERGATE_GATEWAY=${JSON.stringify(filters)}`, 'HYPERGATE_LISTEN=0.0.0.0'],
                    ExposedPorts,
                    Hostname: host,          
                    Labels: {
                        'hypergate.EXCLUDE': 'true'
                    },
                    NetworkingConfig: {
                        EndpointsConfig: {
                            [this.networkName]: {
                                Aliases: [host],
                                // @ts-ignore
                                NetworkID: network.data.Id
                            }
                        }
                    }         
                })
            }
            // @ts-ignore
            if(container.data.State != 'running'){
                await container.start()
            }
        }
    }

    public async stop(){
        this.stopped = true;
        if(this.refreshTimer) clearTimeout(this.refreshTimer);
        const router = this.router;
        const containers = await this.docker.container.list()
        for(const container of containers){
            // @ts-ignore
            if(container.data.Names[0].substring(1).includes(router)){
                await container.stop()
                await container.delete({force:true})
            }
        }
    }

    private async getConnectedServices():Promise<Array<Service>>{
        await this.getNetwork();
        const networkName = this.networkName;
        const services:Array<Service> = []
        const containers = await this.docker.container.list()
        for(let container of containers){
            // @ts-ignore
            const name = container.data.Names[0].substring(1)
            if(name.includes(this.router)) continue;

            // @ts-ignore
            const labels = container.data.Labels;

            if((labels['hypergate.EXCLUDE']||'false').toString().toLowerCase() == 'true') continue;

            const containerStatus = await container.status();
            // @ts-ignore
            const network = containerStatus.data?.NetworkSettings?.Networks[networkName]
            if(!network) continue;
            // @ts-ignore
            const ports = [...container.data.Ports];
        
            const customExposedPorts = (labels['hypergate.EXPOSE']??'').split(',')
            for(const customPort of customExposedPorts){
                let [port,proto] = customPort.split('/')
                if(!port) continue;
                let privatePort;
                let publicPort;
                if (port.includes(':')) {
                    [privatePort, publicPort] = port.split(':')
                } else {
                    privatePort = port
                }
                privatePort = parseInt(privatePort)
                publicPort = publicPort ? parseInt(publicPort) : undefined
                if(!privatePort||isNaN(privatePort)) continue;
                if(publicPort!==undefined && isNaN(publicPort)) continue;
                if(!proto) proto='tcp'
                const existing = ports.find((p:any)=>p.PrivatePort == privatePort && p.Type == proto)
                if(existing) {
                    if(!existing.PublicPort) existing.PublicPort = publicPort
                } else {
                    ports.push({ PrivatePort:privatePort, Type:proto, PublicPort:publicPort })
                }
            }
            // @ts-ignore
            const service = container.data.Ports.map((ps:any)=>{                
                let servicePort = ps.PrivatePort;
                let serviceProto = ps.Type;
                let serviceHost = network?.Aliases?.[0]??name;
                let gatePort = ps.PublicPort;
                let published = !!gatePort;
                if(!gatePort) gatePort = servicePort
                return {
                    servicePort,
                    protocol: serviceProto,
                    serviceHost,
                    gatePort,
                    tags: 'docker '+(published?'published':'')
                } as Service
            })
            services.push(...service)
        }
        return services;
    }

}

