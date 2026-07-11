// internet-checker.ts
import dns from 'dns';
import { exec } from 'child_process';
import os from 'os';
import { promisify } from 'util';

const execPromise = promisify(exec);
const dnsResolvePromise = promisify(dns.resolve);

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
    activeInterfaces: InterfaceInfo[];
    vpnInterfaces: string[];
    dnsServers: string[];
}

export interface NetworkInterfacesResult {
    success: boolean;
    interfaces: InterfaceInfo[];
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
}

export class InternetConnectionChecker {
    private timeout: number;
    private testUrls: string[];
    private dnsServers: string[];
    private verbose: boolean;

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

                const response = await fetch(url, {
                    method: 'HEAD',
                    signal: controller.signal
                });

                clearTimeout(timeoutId);
                const latency = Date.now() - startTime;

                return {
                    success: response.ok || response.status === 200,
                    url,
                    latency
                };
            } catch (error: any) {
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
    checkNetworkInterfaces(): NetworkInterfacesResult {
        const networkInterfaces = os.networkInterfaces();
        const activeInterfaces: InterfaceInfo[] = [];

        for (const [name, iface] of Object.entries(networkInterfaces)) {
            if (!iface) continue;

            for (const addr of iface) {
                if (!addr.internal && addr.family === 'IPv4') {
                    activeInterfaces.push({
                        name,
                        address: addr.address,
                        netmask: addr.netmask || '',
                        mac: addr.mac
                    });
                }
            }
        }

        if (this.verbose) {
            console.log(`Found ${activeInterfaces.length} active interfaces`);
        }

        return {
            success: activeInterfaces.length > 0,
            interfaces: activeInterfaces
        };
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
                interfaces: { success: false, interfaces: [] },
                latency: null
            },
            duration: 0
        };

        // Check network interfaces first
        const interfaces = this.checkNetworkInterfaces();
        results.details.interfaces = interfaces;

        if (!interfaces.success) {
            results.hasInternet = false;
            results.details.error = 'No active network interfaces found';
            results.duration = Date.now() - startTime;
            return results;
        }

        // Detect VPN
        const vpn = this.detectVPN();
        results.details.vpn = vpn;

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
                        interfaces: { success: false, interfaces: [] },
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
            dnsServers: this.dnsServers
        };
    }
}