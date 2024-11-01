# Hypergate

**Hypergate** is a zero-configuration, peer-to-peer encrypted tunnel that enables seamless communication between Docker containers and physical machines across any location, even those behind NAT.

## Components
Hypergate comprises three primary components:
- **Service Providers**: Make local services accessible to the network.
- **Gateways**: Act as entry points, connecting to the appropriate Service Provider.
- **Hypergate Router**: A virtual router connecting Service Providers and Gateways via a secret key that establishes a Hyperswarm connection.

Multiple Gateways and Service Providers can coexist on the same or different machines.

➡️ **Quick Start**: Jump to [Example: Providers-Gateways](#example-1-one-provider-one-gateway-with-docker) or [Example: Docker Network](#example-2-docker-virtual-network) for quick examples.

---

# Usage Overview
Hypergate supports several usage modes:

- **Docker Bridge Network**: Bridges Docker networks across hosts, enabling container communication as if on the same machine.
- **Docker Gateway**: Exposes Docker containers to the internet, bypassing NAT or firewall limitations.
- **Generic Gateway or Reverse Proxy**: Exposes machine services behind NAT/firewall to the internet.
- **P2P VPN**: Connects machines behind NAT/firewalls for direct interaction, such as gaming.

Combine these modes for complex configurations tailored to specific use cases.

## Getting Started
- To use **Hypergate** with Docker:
  - [Docker](https://www.docker.com/) must be installed.

- To use **Hypergate** without Docker:
  - Download the "hypergate" executable from the [release page](https://github.com/riccardobl/hypergate/releases) *(for x86_64 Linux)*.
  - Or, clone the repository and run:
    ```bash
    npm i
    npm run build
    npm run start
    ```

---

# Network Configuration
### One Provider, One Gateway vs. Multiple Providers, Multiple Gateways

| Single Provider & Gateway  | Multiple Providers & Gateways |
| -------------------------- | ----------------------------- |
| ![Single Provider and Gateway](static/gateway-provider.jpg) | ![Multiple Providers and Gateways](static/multi-gateway-provider.jpg) |

In Hypergate, Service Providers are authoritative, updating Gateway routing tables to expose services. If multiple Providers compete for the same port, a round-robin method selects the next available Provider.

⚠️ **Security Tip**: Protect the Hypergate Router secret carefully to avoid unauthorized network reconfigurations. Use multiple routers to isolate services if different trust levels are needed.

---

# Docker Virtual Network

| Docker Virtual Network |
| ---------------------- |
| ![Docker Virtual Network](static/virtual-network.jpg) |

**Hypergate** simplifies container networking, allowing containers in the same Hypergate network to communicate without complex configurations or port mappings. It leverages Hyperswarm for P2P connections, enabling NAT traversal through hole-punching techniques, with all connections automatically encrypted.

Containers using the `EXPOSE` directive in Dockerfiles are automatically configured. Alternatively, specify ports with the `hypergate.EXPOSE` label in the `docker run` command.

### Custom Docker Labels
- `hypergate.EXCLUDE="true|false"`: Exclude a container from announcements by the Service Provider.
- `hypergate.EXPOSE="port[:public port][/protocol]"`: CSV list of ports to expose. Protocol defaults to TCP if omitted.
- `hypergate.UNEXPOSE="port[/protocol]"`: CSV list of exposed port to ignore. Only ports exposed by the Dockerfile EXPOSE directive are affected by this label. If `*` is used, all ports exposed by the Dockerfile are ignored.

---

# Examples

## Example 1: Exposing an HTTP Server Behind NAT
This example exposes an HTTP server on MACHINE1 using a Service Provider and a Gateway on MACHINE2.

### Steps:
1. **Start HTTP Service on MACHINE1**
    ```bash
    mkdir -p /tmp/www-test
    cd /tmp/www-test
    echo "Hello World" > index.html
    busybox httpd -p 8080 -f .
    ```

2. **Create the Router**
    ```bash
    $ hypergate --new
    ```

3. **Start Service Provider on MACHINE1**
    ```bash
    $ hypergate --router <router-key> --provider services/http.json
    ```

4. **Start Gateway on MACHINE2**
    ```bash
    $ hypergate --router <router-key> --listen 0.0.0.0 --gateway
    ```

    **Note**: By default, the gateway will expose all services announced to the router. This behavior is generally desirable, but in some cases, you may want to limit exposure to specific services—such as if you have competing services on the same port or have concerns about provider trust. To achieve this, pass the same service definition used by the provider to the gateway, ensuring only that service is exposed:
    ```bash
    $ hypergate --router <router-key> --listen 0.0.0.0 --gateway services/http.json
    ```

**Test**: Connect to MACHINE2:8080 to view the "Hello World" page from MACHINE1.

---

## Example 2: Bridging a Docker Network with Gateway Creation
This example bridges networks across MACHINE1, MACHINE2, and MACHINE3, where:
- MACHINE1 hosts a MariaDB instance.
- MACHINE2 hosts phpMyAdmin connecting to MariaDB.
- MACHINE3 exposes phpMyAdmin publicly.

### Steps:
1. **Create Router Key**
    ```bash
    $ docker run -it --rm hypergate --new
    ```

2. **Start Service Provider on MACHINE1**
    ```bash
    $ docker run -it --rm -u root --name="hypergate-sp-machine1" -v /var/run/docker.sock:/var/run/docker.sock hypergate --router <router-key> --docker --provider --network hypergatenet
    ```

3. **Start MariaDB on MACHINE1 and connect to the network**
    ```bash
    docker run -d --rm --name test-mysql -eMYSQL_ROOT_HOST=% -eMYSQL_DATABASE=wp -e MYSQL_ROOT_PASSWORD=secretpassword --label hypergate.EXPOSE=3306 mysql

    docker network connect hypergatenet test-mysql --alias mysql.hyper
    ```

4. **Start Gateway on MACHINE2**
    ```bash
    docker run -it --rm -u root --name="hypergate-gw-machine2" -v /var/run/docker.sock:/var/run/docker.sock hypergate --router <router-key> --docker --gateway --listen 0.0.0.0 --network hypergatenet
    ```

5. **Start Service Provider on MACHINE2**
    ```bash
    docker run -it --rm -u root --name="hypergate-sp-machine2" -v /var/run/docker.sock:/var/run/docker.sock hypergate --router <router-key> --docker --provider --network hypergatenet
    ```

6. **Start phpMyAdmin on MACHINE2 and connect to the network**
    ```bash
    docker run --rm --name test-phpmyadmin -d -e PMA_HOST=mysql.hyper --label hypergate.EXPOSE=80 phpmyadmin
    docker network connect hypergatenet test-phpmyadmin --alias phpmyadmin.hyper
    ```

7. **Start Gateway on MACHINE3**
    ```bash
    docker run -it --rm -u root --name="hypergate-gw-machine3" -v /var/run/docker.sock:/var/run/docker.sock -p 8080:80 hypergate --router <router-key> --docker --gateway --listen 0.0.0.0 --network hypergatenet --exposeOnlyServices phpmyadmin.hyper
    ```

**Test**: Access phpMyAdmin by connecting to MACHINE3:8080.




# License and Warranty

This is an experimental free software, there is no warranty. You are free to use, modify and redistribute it under certain conditions. 

See the [LICENSE](LICENSE) file for details.

This is an experimental software, it might or might not be production ready or even work as expected. 

Use it at your own discretion.

# Similar projects
Other projects related to sharing services with hyperswarm

- [hypertele](https://github.com/bitfinexcom/hypertele) :  A swiss-knife proxy powered by Hyperswarm DHT 
- [hyperseaport](https://github.com/ryanramage/hyperseaport) :  A p2p service registry 
- [hyperssh](https://github.com/mafintosh/hyperssh) :  Run SSH over hyperswarm! 
- [hyperbeam](https://github.com/mafintosh/hyperbeam) :  A 1-1 end-to-end encrypted internet pipe powered by Hyperswarm 