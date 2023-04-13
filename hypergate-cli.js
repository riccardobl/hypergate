#!/usr/bin/env node
import ServiceProvider from "./ServiceProvider.js";
import Gateway from "./Gateway.js";
import Utils from "./Utils.js";
import Minimist from 'minimist';
import Fs from 'fs';
// import UDXBinding from "udx-native/lib/binding.js";

function prepareLogger(tag, debug) {
    const _console_log = console.log;
    const _console_info = console.info;
    const _console_error = console.error;
    const _console_warn = console.warn;

    console.log = function (...args) {
        if (debug) _console_log(tag + " [LOG]", ...args);
    };
    console.info = function (...args) {
        _console_info(tag + " [INFO]", ...args);
    };
    console.error = function (...args) {
        _console_error(tag + " [ERROR]", ...args);
    };
    console.warn = function (...args) {
        _console_warn(tag + " [WARN]", ...args);
    };

}

function disableIPv6(argv) {
//     const _udx_napi_socket_bind = UDXBinding.udx_napi_socket_bind;
//     UDXBinding.udx_napi_socket_bind = function (...args) {
//         if (args[3] == 6) throw "IPv6 is disabled"
//         return _udx_napi_socket_bind(...args);
//     }
}


async function peer(secret, argv) {
    prepareLogger("[SERVICE PROVIDER]", argv.verbose)
    const peer = new ServiceProvider(secret);
    if (argv.api) {
        peer.startHttpApi(argv.api || "127.0.0.1:44443");
    }
    const addServices = (services) => {
        for (let service of services) {
            service = service.trim();
            if (service.startsWith("#")) continue;
            if (service.startsWith("@")) {
                const filePath = service.substring(1);
                if (Fs.existsSync(filePath)) {
                    const fileContent = Fs.readFileSync(filePath, "utf8").trim();
                    if (fileContent != "") addServices(fileContent.split("\n"));
                } else {
                    console.warn("File", filePath, "does not exist");
                }
            } else {
                let [gatePort, serviceHost, servicePortProto] = service.split(";");
                if (!servicePortProto) servicePortProto = "8080/tcp";
                else if (!servicePortProto.includes("/")) servicePortProto = servicePortProto + "/tcp";
                const [servicePort, serviceProto] = servicePortProto.split("/");
                console.info("Expose service", serviceHost + ":" + servicePort + "/" + serviceProto, "to gate", gatePort);


                peer.addService(gatePort, serviceHost, servicePort, serviceProto);
            }
        }
    }
    if (argv.service) {
        const services = typeof argv.service == "object" ? argv.service : [argv.service];

        addServices(services);
    }
}



async function gate(secret, argv) {
    prepareLogger("[GATEWAY]", argv.verbose);
    const listen = argv.listen || "127.0.0.1";
    console.info("Start gateway on", listen);
    let gateTransformer = (info) => undefined;
    if (argv.allowGates) {
        const allowedGates = argv.allowGates.split(",").map(p => {
            p = p.trim();

            return p;
        });
        console.log("Allowed gates", allowedGates);



        gateTransformer = (info) => {
            console.log(info);
            let allowed = false;
            if (!allowed) allowed ||= allowedGates.indexOf("all") != -1;
            if (!allowed) allowed ||= info.protocol == "udp" && allowedGates.indexOf("all/udp") != -1;
            if (!allowed) allowed ||= info.protocol == "tcp" && allowedGates.indexOf("all/tcp") != -1;
            if (!allowed) allowed ||= info.protocol == "udp" && info.portBind && allowedGates.indexOf("allports/udp") != -1;
            if (!allowed) allowed ||= info.protocol == "tcp" && info.portBind && allowedGates.indexOf("allports/tcp") != -1;
            if (!allowed) allowed ||= !info.portBind && allowedGates.indexOf("allaliases") != -1;
            if (!allowed) allowed ||= info.protocol == "udp" && !info.portBind && allowedGates.indexOf("allaliases/udp") != -1;
            if (!allowed) allowed ||= info.protocol == "tcp" && !info.portBind && allowedGates.indexOf("allaliases/tcp") != -1;
            if (!allowed) allowed ||= allowedGates.indexOf(info.port + "/" + info.protocol) != -1;
            if (!allowed) allowed ||= allowedGates.indexOf(info.port) != -1;
            if (!allowed) allowed ||= allowedGates.indexOf(info.gate) != -1;
            if (!allowed) allowed ||= !info.portBind && allowedGates.indexOf(info.hostProto) != -1;
            if (!allowed) allowed ||= !info.portBind && allowedGates.indexOf(info.hostProto + "/" + info.protocol) != -1;
            if (!allowed) allowed ||= allowedGates.indexOf(info.gate.split("/")[0]) != -1;
            return allowed ? info : undefined;

        };


    }
    const peer = new Gateway(secret, listen, gateTransformer);
    if (argv.api) {
        peer.startHttpApi(argv.api || "127.0.0.1:44443");
    }
}


function help() {
    const launchCmd = process.argv[0] + " " + process.argv[1];
    console.info(`Usage:
    As Gateway:
        ${launchCmd} --gateway <secret> [--listen <ip>] [--verbose] [--allowPorts <port1[/tcp],port2[/udp],... | all>] [--ipv6]


    As Service Provider:
        ${launchCmd} --provider <secret> --service <gatePort[/udp]>:<serviceHost>:<servicePort> [--service ...] [--verbose] [--ipv6]
            --service   can be specified multiple times and can also point to a file containing a list of services (one per line in the format <gatePort>:<serviceHost>:<servicePort>). 
                        The file path must be prefixed with @ (e.g. --service @/path/to/services.txt)

                        
    As Secret Generator:
        ${launchCmd} --newSecret
    `);
}


function newSecret() {
    console.info(Utils.newSecret());
}

const argv = Minimist(process.argv.slice(2));
if (argv.help) {
    help();
} else {
    if (!argv.ipv6) {
        disableIPv6(argv);
    }
    if (argv.gateway) {
        gate(argv.gateway, argv);
    } else if (argv.provider) {
        peer(argv.provider, argv);
    } else if (argv.newSecret) {
        newSecret(argv);
    } else {
        help();
    }
}
