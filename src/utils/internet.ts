import dns from 'dns';
import { exec } from 'child_process';
import os from 'os';
import { promisify } from 'util';
import { fetch, ProxyAgent } from 'undici';
import { execFile } from 'child_process';
import log from 'electron-log/main';


const execPromise = promisify(exec);

// Types
export interface CheckResult {
    success: boolean;
    url?: string;
    latency?: number;
    error?: string;
    server?: string;
    output?: string;
}

export interface DNSResult {
    success: boolean;
    server: string;
    latency?: number;
    error?: string;
}

export interface InterfaceInfo {
    name: string;
    address: string;
    netmask: string;
    mac: string;
}

export interface ConnectionInfo {
    isConnected: boolean;
    latency: number | null;
    hasVPN: boolean;
    // activeInterfaces: InterfaceInfo[];
    activeInterfaces: string[];
    vpnInterfaces: string[];
    dnsServers: string[];
}

export interface NetworkInterfacesResult {
    success: boolean;
    // interfaces: InterfaceInfo[];
    checked: boolean;
    interfaces: string[];
}

export interface VPNResult {
    hasVPN: boolean;
    interfaces: Array<{
        name: string;
        addresses: string[];
    }>;
}

export interface ConnectionDetails {
    timestamp: string;
    hasInternet: boolean;
    methods: {
        HTTP?: CheckResult;
        DNS?: CheckResult;
        Ping?: CheckResult;
    };
    details: {
        vpn: VPNResult;
        interfaces: NetworkInterfacesResult;
        latency: number | null;
        error?: string;
    };
    duration: number;
}

export interface InternetCheckerOptions {
    timeout?: number;
    testUrls?: string[];
    dnsServers?: string[];
    verbose?: boolean;
    proxy?: string;
}

export class InternetConnectionChecker {
    private timeout: number;
    private testUrls: string[];
    private dnsServers: string[];
    private verbose: boolean;
    private interfaces: NetworkInterfacesResult;
    private vpn: VPNResult

    constructor(options: InternetCheckerOptions = {}) {
        this.timeout = options.timeout || 5000;
        this.testUrls = options.testUrls || [
            'https://www.google.com',
            'https://www.cloudflare.com',
            'https://www.microsoft.com',
            'https://1.1.1.1',
            'https://8.8.8.8'
        ];
        this.dnsServers = options.dnsServers || ['8.8.8.8', '1.1.1.1', '9.9.9.9'];
        this.verbose = options.verbose || false;
        this.interfaces = {
            interfaces: [],
            checked: false,
            success: false
        }
        this.vpn = {
            hasVPN: false,
            interfaces: []
        }

        // Check network interfaces first
        this.checkNetworkInterfaces();
    }



    /**
     * Get Enable Proxy
     */
    async checkEnableProxy(): Promise<boolean> {
        return new Promise((resolve, reject) => {
            execFile(
                "reg",
                [
                    "query",
                    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
                    "/v",
                    "ProxyEnable",
                ],
                (err, stdout) => {
                    if (err) return resolve(false);

                    let status: boolean = stdout.split(" ")[stdout.split(" ").length - 1].includes("0x1") ? true : false;
                    resolve(status);
                }
            );
        });
    }


    /**
     * Get Proxy Address
     */
    async getProxyAddress(): Promise<string | null> {
        return new Promise((resolve, reject) => {
            execFile(
                "reg",
                [
                    "query",
                    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
                    "/v",
                    "ProxyServer",
                ],
                (err, stdout) => {
                    if (err) return resolve(null);

                    let status: string = stdout.split(" ")[stdout.split(" ").length - 1];
                    // This regex matches IP:port patterns (both IPv4 and hostname:port)
                    const proxyMatch = status.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+)/);
                    // Or if you want to match both IP and hostname:
                    // const proxyMatch = status.match(/([\w.-]+:\d+)/);

                    const proxyAddress = proxyMatch ? proxyMatch[1] : null;
                    resolve(proxyAddress);
                }
            );
        });
    }


    /**
     * Check internet via HTTP requests
     */
    async checkViaHTTP(): Promise<{ success: boolean; results: CheckResult[]; latency: number | null }> {
        const promises = this.testUrls.map(async (url): Promise<CheckResult> => {
            try {
                const startTime = Date.now();
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), this.timeout);

                const proxyAddress: string | null = await this.getProxyAddress();
                const isProxyEnable: boolean = await this.checkEnableProxy();

                const condition = (isProxyEnable && proxyAddress !== null)

                const response = await fetch(url, {
                    method: 'HEAD',
                    signal: controller.signal,
                    // set proxy to check request if user set a proxy
                    ...(condition && {
                        dispatcher: new ProxyAgent('http://'+proxyAddress)
                    })
                });

                clearTimeout(timeoutId);
                const latency = Date.now() - startTime;

                log.info('response', response, condition, url)

                return {
                    success: response.ok || response.status === 200,
                    url,
                    latency
                };
            } catch (error: any) {
                // log.error('error of req', error)
                // console.log(error)
                return {
                    success: false,
                    url,
                    error: error.message || 'Unknown error'
                };
            }
        });

        const results = await Promise.all(promises);
        const successful = results.filter(r => r.success);
        const latencies = successful.map(r => r.latency).filter((l): l is number => l !== undefined);

        if (this.verbose) {
            console.log(`HTTP check: ${successful.length}/${results.length} successful`);
        }

        return {
            success: successful.length > 0,
            results,
            latency: latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null
        };
    }

    /**
     * Check internet via DNS resolution
     */
    async checkViaDNS(): Promise<{ success: boolean; results: DNSResult[]; latency: number | null }> {
        const promises = this.dnsServers.map(async (server): Promise<DNSResult> => {
            try {
                const startTime = Date.now();

                // Use custom DNS server
                const resolver = new dns.Resolver();
                resolver.setServers([server]);

                await promisify(resolver.resolve.bind(resolver))('google.com');

                const latency = Date.now() - startTime;
                return { success: true, server, latency };
            } catch (error: any) {
                return {
                    success: false,
                    server,
                    error: error.message || 'DNS resolution failed'
                };
            }
        });

        const results = await Promise.all(promises);
        const successful = results.filter(r => r.success);
        const latencies = successful.map(r => r.latency).filter((l): l is number => l !== undefined);

        if (this.verbose) {
            console.log(`DNS check: ${successful.length}/${results.length} successful`);
        }

        return {
            success: successful.length > 0,
            results,
            latency: latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null
        };
    }

    /**
     * Check internet via ping
     */
    async checkViaPing(): Promise<CheckResult> {
        const platform = os.platform();
        const target = '8.8.8.8';
        let pingCommand: string;

        if (platform === 'win32') {
            pingCommand = `ping -n 1 -w ${this.timeout} ${target}`;
        } else {
            pingCommand = `ping -c 1 -W ${Math.floor(this.timeout / 1000)} ${target}`;
        }

        try {
            const startTime = Date.now();
            const { stdout, stderr } = await execPromise(pingCommand);
            const latency = Date.now() - startTime;

            // Parse latency from ping output
            const latencyMatch = stdout.match(/time[=<](\d+\.?\d*)/i);
            const parsedLatency = latencyMatch ? parseFloat(latencyMatch[1]) : latency;

            if (stderr && this.verbose) {
                console.warn('Ping stderr:', stderr);
            }

            if (this.verbose) {
                console.log('Ping successful');
            }

            return {
                success: true,
                latency: parsedLatency,
                output: stdout
            };
        } catch (error: any) {
            if (this.verbose) {
                console.log('Ping failed:', error.message);
            }
            return {
                success: false,
                error: error.message || 'Ping failed'
            };
        }
    }

    /**
     * Check network interfaces
     */
    // checkNetworkInterfaces(): NetworkInterfacesResult {
    //     const networkInterfaces = os.networkInterfaces();
    //     const activeInterfaces: InterfaceInfo[] = [];

    //     for (const [name, iface] of Object.entries(networkInterfaces)) {
    //         if (!iface) continue;

    //         for (const addr of iface) {
    //             console.log(addr)
    //             if (!addr.internal && addr.family === 'IPv4') {
    //                 activeInterfaces.push({
    //                     name,
    //                     address: addr.address,
    //                     netmask: addr.netmask || '',
    //                     mac: addr.mac
    //                 });
    //             }
    //         }
    //     }

    //     if (this.verbose) {
    //         console.log(`Found ${activeInterfaces.length} active interfaces`);
    //     }

    //     return {
    //         success: activeInterfaces.length > 0,
    //         interfaces: activeInterfaces
    //     };
    // }
    async checkNetworkInterfaces(): Promise<NetworkInterfacesResult> {
        if (os.platform() !== 'win32') {
            // For non-Windows, fallback to a blocklist (see later)
            this.interfaces = {
                interfaces: [],
                success: false,
                checked: true
            };
        }

        try {
            // PowerShell command to get names of physical adapters
            const { stdout } = await execPromise(
                `powershell -Command "Get-NetAdapter -Physical | Select-Object -ExpandProperty Name"`
            );
            // Split lines and filter empty ones
            const names = stdout.split('\n')
                .map(line => line.trim())
                .filter(name => name.length > 0);

            this.interfaces = {
                success: names.length > 0,
                interfaces: names,
                checked: true
            };
            return this.interfaces;
        } catch (error: any) {
            console.warn('Failed to get physical adapters via PowerShell:', error.message);
            this.interfaces = {
                interfaces: [],
                success: false,
                checked: false
            };
            return this.interfaces;
        }



    }

    /**
     * Detect VPN connections
     */
    detectVPN(): VPNResult {
        const networkInterfaces = os.networkInterfaces();
        const vpnIndicators = ['tun', 'tap', 'ppp', 'utun', 'ipsec', 'openvpn', 'wg'];
        const vpnInterfaces: Array<{ name: string; addresses: string[] }> = [];

        for (const [name, iface] of Object.entries(networkInterfaces)) {
            if (!iface) continue;

            const isVPN = vpnIndicators.some(indicator =>
                name.toLowerCase().includes(indicator)
            );

            if (isVPN) {
                vpnInterfaces.push({
                    name,
                    addresses: iface.map(addr => addr.address)
                });
            }
        }

        if (this.verbose) {
            console.log(`Found ${vpnInterfaces.length} VPN interfaces`);
        }

        return {
            hasVPN: vpnInterfaces.length > 0,
            interfaces: vpnInterfaces
        };
    }

    /**
     * Comprehensive internet connection check
     */
    async checkConnection(): Promise<ConnectionDetails> {
        const startTime = Date.now();

        const results: ConnectionDetails = {
            timestamp: new Date().toISOString(),
            hasInternet: false,
            methods: {},
            details: {
                vpn: { hasVPN: false, interfaces: [] },
                interfaces: { success: false, interfaces: [], checked: false },
                latency: null
            },
            duration: 0
        };

        if (!this.interfaces.checked)
            await this.checkNetworkInterfaces()


        if (!this.interfaces.success) {
            results.hasInternet = false;
            results.details.error = 'No active network interfaces found';
            results.duration = Date.now() - startTime;
            return results;
        }

        // Detect VPN
        this.vpn = this.detectVPN();
        results.details.vpn = this.vpn;

        // Try multiple methods
        const methodTests: Array<{
            name: string;
            fn: () => Promise<any>;
        }> = [
                { name: 'HTTP', fn: this.checkViaHTTP.bind(this) },
                // { name: 'DNS', fn: this.checkViaDNS.bind(this) },
                // { name: 'Ping', fn: this.checkViaPing.bind(this) }
            ];

        let anySuccess = false;
        const latencies: number[] = [];

        for (const method of methodTests) {
            try {
                const result = await method.fn();
                results.methods[method.name] = result;

                if (result.success) {
                    anySuccess = true;
                    if (result.latency !== null && result.latency !== undefined) {
                        latencies.push(result.latency);
                    }
                }
            } catch (error: any) {
                results.methods[method.name] = {
                    success: false,
                    error: error.message || 'Unknown error'
                };
            }
        }

        // Calculate average latency
        if (latencies.length > 0) {
            results.details.latency = Math.round(
                latencies.reduce((a, b) => a + b, 0) / latencies.length
            );
        }

        results.hasInternet = anySuccess;
        results.duration = Date.now() - startTime;

        return results;
    }

    /**
     * Quick check - returns boolean
     */
    async isConnected(): Promise<boolean> {
        const result = await this.checkConnection();
        return result.hasInternet;
    }

    /**
     * Monitor connection status with callback
     */
    monitorConnection(
        interval: number = 5000,
        callback: (connected: boolean, details: ConnectionDetails) => void
    ): () => void {
        let previousState = false;
        let isRunning = true;

        const check = async (): Promise<void> => {
            if (!isRunning) return;

            try {
                const result = await this.checkConnection();
                const isConnected = result.hasInternet;

                if (isConnected !== previousState) {
                    previousState = isConnected;
                    callback(isConnected, result);
                }
            } catch (error: any) {
                console.error('Monitor connection error:', error);
                callback(false, {
                    timestamp: new Date().toISOString(),
                    hasInternet: false,
                    methods: {},
                    details: {
                        vpn: { hasVPN: false, interfaces: [] },
                        interfaces: { success: false, interfaces: [], checked: false },
                        latency: null,
                        error: error.message
                    },
                    duration: 0
                });
            }

            if (isRunning) {
                setTimeout(check, interval);
            }
        };

        // Start monitoring
        check();

        // Return stop function
        return () => {
            isRunning = false;
        };
    }

    /**
     * Check specific aspects of connection
     */
    async getConnectionInfo(): Promise<ConnectionInfo> {
        const result = await this.checkConnection();

        return {
            isConnected: result.hasInternet,
            latency: result.details.latency,
            hasVPN: result.details.vpn.hasVPN,
            activeInterfaces: result.details.interfaces.interfaces,
            vpnInterfaces: result.details.vpn.interfaces.map(i => i.name),
            dnsServers: this.dnsServers,
            ...result
        };
    }
}