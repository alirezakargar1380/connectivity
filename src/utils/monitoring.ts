// network-monitor.ts
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execPromise = promisify(exec);

// Type Definitions
interface NetworkInterfaceInfo {
    addresses: string[];
    bytesReceived: number;
    bytesSent: number;
    lastBytesReceived: number;
    lastBytesSent: number;
    speedDown: number;
    speedUp: number;
    rxBytes: number;
    txBytes: number;
}

interface NetworkInterfaces {
    [key: string]: NetworkInterfaceInfo;
}

interface NetworkStats {
    totalReceived: number;
    totalSent: number;
    interfaces: {
        [key: string]: {
            received: number;
            sent: number;
        };
    };
}

interface ProcessStats {
    [key: string]: {
        connections: number;
        type: string;
    };
}

interface TotalUsage {
    downloaded: number;
    uploaded: number;
    total: number;
    startTime: Date;
    lastUpdate: number;
    lastTotalReceived?: number;
    lastTotalSent?: number;
}

interface SpeedResult {
    downloadSpeed: number;
    uploadSpeed: number;
    totalReceived: number;
    totalSent: number;
    receivedDiff: number;
    sentDiff: number;
}

interface HistoryEntry {
    timestamp: string;
    downloaded: number;
    uploaded: number;
    total: number;
    duration: number;
}

interface DailyStats {
    downloaded: number;
    uploaded: number;
    total: number;
}

class NetworkMonitor {
    private interfaces: NetworkInterfaces = {};
    private totalUsage: TotalUsage;
    private history: HistoryEntry[] = [];
    private historyFile: string;
    private isRunning: boolean = false;
    private updateInterval: NodeJS.Timeout | null = null;
    private saveInterval: NodeJS.Timeout | null = null;
    private processStats: ProcessStats = {};
    private previousStats: NetworkStats | null = null;

    constructor() {
        this.totalUsage = {
            downloaded: 0,
            uploaded: 0,
            total: 0,
            startTime: new Date(),
            lastUpdate: Date.now()
        };
        this.historyFile = path.join(__dirname, 'network-history.json');

        // Load history
        this.loadHistory();

        // Get initial interface stats
        this.getNetworkInterfaces();
    }

    private loadHistory(): void {
        try {
            if (fs.existsSync(this.historyFile)) {
                const data = fs.readFileSync(this.historyFile, 'utf8');
                this.history = JSON.parse(data);
                // console.log(`📂 Loaded ${this.history.length} historical records`);
            }
        } catch (err: any) {
            console.warn('No history file found, starting fresh');
            this.history = [];
        }
    }

    private saveHistory(): void {
        try {
            // Keep only last 1000 entries
            if (this.history.length > 1000) {
                this.history = this.history.slice(-1000);
            }
            fs.writeFileSync(this.historyFile, JSON.stringify(this.history, null, 2));
        } catch (err: any) {
            console.error('Failed to save history:', err.message);
        }
    }

    private getNetworkInterfaces(): NetworkInterfaces {
        const interfaces = os.networkInterfaces();
        const activeInterfaces: NetworkInterfaces = {};

        for (const [name, iface] of Object.entries(interfaces)) {
            if (!iface) continue;
            for (const addr of iface) {
                // Only track IPv4 addresses that are not internal
                if (addr.family === 'IPv4' && !addr.internal) {
                    console.log(addr)
                    if (!activeInterfaces[name]) {
                        activeInterfaces[name] = {
                            addresses: [],
                            bytesReceived: 0,
                            bytesSent: 0,
                            lastBytesReceived: 0,
                            lastBytesSent: 0,
                            speedDown: 0,
                            speedUp: 0,
                            rxBytes: 0,
                            txBytes: 0
                        };
                    }
                    activeInterfaces[name].addresses.push(addr.address);
                }
            }
        }

        this.interfaces = activeInterfaces;
        return activeInterfaces;
    }

    // Get network statistics using OS-specific commands
    private async getNetworkStats(): Promise<NetworkStats> {
        const platform = os.platform();
        let stats: NetworkStats = {
            totalReceived: 0,
            totalSent: 0,
            interfaces: {}
        };

        try {
            if (platform === 'win32') {
                stats = await this.getWindowsNetworkStats();
            } else if (platform === 'linux') {
                stats = await this.getLinuxNetworkStats();
            } else if (platform === 'darwin') {
                stats = await this.getMacNetworkStats();
            } else {
                console.log('im else stats')
                stats = this.getOSNetworkStats();
            }
        } catch (err: any) {
            console.error('Error getting network stats:', err.message);
            stats = this.getOSNetworkStats();
        }

        // Log the stats to debug
        // console.log('📊 Network Stats:', JSON.stringify(stats, null, 2));

        return stats;
    }

    // Windows network stats using PowerShell with better approach
    private async getWindowsNetworkStats(): Promise<NetworkStats> {
        try {
            // Better PowerShell command to get network statistics
            const { stdout } = await execPromise(`
                powershell -Command "
                    Get-NetAdapter -Physical | 
                    ForEach-Object {
                        $stats = Get-NetAdapterStatistics -Name $_.Name
                        [PSCustomObject]@{
                            Name = $_.Name
                            ReceivedBytes = $stats.ReceivedBytes
                            SentBytes = $stats.SentBytes
                        }
                    } | ConvertTo-Json
                "
            `);

            const stats: NetworkStats = {
                totalReceived: 0,
                totalSent: 0,
                interfaces: {}
            };

            try {
                const data = JSON.parse(stdout);
                console.log("data", data)
                const items = Array.isArray(data) ? data : [data];

                for (const item of items) {
                    if (item && item.Name) {
                        const received = parseInt(item.ReceivedBytes) || 0;
                        const sent = parseInt(item.SentBytes) || 0;

                        stats.interfaces[item.Name] = {
                            received: received,
                            sent: sent
                        };
                        stats.totalReceived += received;
                        stats.totalSent += sent;
                    }
                }
            } catch (parseError) {
                // If JSON parsing fails, try parsing the raw output
                const lines = stdout.split('\n').filter(line => line.trim());
                for (const line of lines) {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length >= 3) {
                        const name = parts[0];
                        const received = parseInt(parts[1]) || 0;
                        const sent = parseInt(parts[2]) || 0;

                        stats.interfaces[name] = { received, sent };
                        stats.totalReceived += received;
                        stats.totalSent += sent;
                    }
                }
            }

            // If still no data, fallback to netstat
            if (stats.totalReceived === 0 && stats.totalSent === 0) {
                return this.getWindowsNetstatStats();
            }

            return stats;
        } catch (err: any) {
            console.error('PowerShell command failed, trying netstat:', err.message);
            return this.getWindowsNetstatStats();
        }
    }

    // Alternative Windows method using netstat
    private async getWindowsNetstatStats(): Promise<NetworkStats> {
        try {
            // Get ALL connected interfaces
            const { stdout: interfaceStdout } = await execPromise(
                'netsh interface show interface | findstr "Connected"'
            );

            const stats: NetworkStats = {
                totalReceived: 0,
                totalSent: 0,
                interfaces: {}
            };

            // Parse all connected interfaces
            const lines = interfaceStdout.split('\n');
            const interfaceNames: string[] = [];

            for (const line of lines) {
                if (line.includes('Connected')) {
                    const parts = line.trim().split(/\s+/);
                    // Format: State   Type   Name
                    // Example: "Connected    Dedicated    Wi-Fi"
                    if (parts.length >= 3) {
                        // Get the name (last part after State and Type)
                        const name = parts.slice(2).join(' ');
                        interfaceNames.push(name);
                        // console.log(`📡 Found connected interface: "${name}"`);
                    }
                }
            }

            if (interfaceNames.length === 0) {
                // console.warn('⚠️ No connected interfaces found');
                return this.getWindowsNetstatFallback();
            }

            // Get stats for ALL connected interfaces using PowerShell
            try {
                // Build PowerShell command to get stats for all interfaces
                const psCommand = interfaceNames.map(name =>
                    `Get-NetAdapterStatistics -Name '${name}' | Select-Object Name, ReceivedBytes, SentBytes`
                ).join('; ');

                const { stdout } = await execPromise(
                    `powershell -Command "${psCommand} | ConvertTo-Json"`
                );

                // Parse JSON output
                try {
                    const data = JSON.parse(stdout);
                    const items = Array.isArray(data) ? data : [data];

                    for (const item of items) {
                        if (item && item.Name) {
                            const received = parseInt(item.ReceivedBytes) || 0;
                            const sent = parseInt(item.SentBytes) || 0;

                            stats.interfaces[item.Name] = { received, sent };
                            stats.totalReceived += received;
                            stats.totalSent += sent;

                            console.log(`📊 ${item.Name}: RX=${received}, TX=${sent}`);
                        }
                    }

                    if (stats.totalReceived > 0 || stats.totalSent > 0) {
                        // console.log(`📊 Total: RX=${stats.totalReceived}, TX=${stats.totalSent}`);
                        return stats;
                    }
                } catch (parseError) {
                    // console.log('JSON parsing failed, trying text parsing...');
                    // If JSON parsing fails, try parsing text output
                    for (const name of interfaceNames) {
                        const regex = new RegExp(`${name}[\\s\\S]*?ReceivedBytes[\\s]*:?\\s*(\\d+)[\\s\\S]*?SentBytes[\\s]*:?\\s*(\\d+)`, 'i');
                        const match = stdout.match(regex);
                        if (match) {
                            const received = parseInt(match[1]) || 0;
                            const sent = parseInt(match[2]) || 0;
                            stats.interfaces[name] = { received, sent };
                            stats.totalReceived += received;
                            stats.totalSent += sent;
                            console.log(`📊 ${name}: RX=${received}, TX=${sent}`);
                        }
                    }

                    if (stats.totalReceived > 0 || stats.totalSent > 0) {
                        return stats;
                    }
                }
            } catch (psError: any) {
                // console.log('PowerShell Get-NetAdapterStatistics failed, trying netsh...');
            }

            // Alternative: Use netsh for ALL interfaces
            try {
                const { stdout } = await execPromise(
                    'netsh interface ipv4 show subinterfaces'
                );

                const lines = stdout.split('\n');
                for (const line of lines) {
                    if (line.trim()) {
                        const parts = line.trim().split(/\s+/);
                        // Format: MTU  MediaSenseState  BytesIn  BytesOut  Interface
                        if (parts.length >= 5) {
                            const bytesIn = parseInt(parts[2]) || 0;
                            const bytesOut = parseInt(parts[3]) || 0;
                            const name = parts.slice(4).join(' ');

                            // Check if this interface is in our connected list
                            if (interfaceNames.some(iface => name.includes(iface) || iface.includes(name))) {
                                stats.interfaces[name] = {
                                    received: bytesIn,
                                    sent: bytesOut
                                };
                                stats.totalReceived += bytesIn;
                                stats.totalSent += bytesOut;
                                // console.log(`📊 Netsh ${name}: RX=${bytesIn}, TX=${bytesOut}`);
                            }
                        }
                    }
                }

                if (stats.totalReceived > 0 || stats.totalSent > 0) {
                    return stats;
                }
            } catch (netshError: any) {
                // console.log('Netsh failed...');
            }

            // If we couldn't get specific interface stats, try getting all network adapters
            try {
                const { stdout } = await execPromise(
                    `powershell -Command "Get-NetAdapter -Physical | ForEach-Object { $stats = Get-NetAdapterStatistics -Name $_.Name; [PSCustomObject]@{Name=$_.Name; ReceivedBytes=$stats.ReceivedBytes; SentBytes=$stats.SentBytes} } | ConvertTo-Json"`
                );

                try {
                    const data = JSON.parse(stdout);
                    const items = Array.isArray(data) ? data : [data];

                    for (const item of items) {
                        if (item && item.Name) {
                            const received = parseInt(item.ReceivedBytes) || 0;
                            const sent = parseInt(item.SentBytes) || 0;

                            // Only add if it's one of our connected interfaces
                            if (interfaceNames.some(name => item.Name.includes(name) || name.includes(item.Name))) {
                                stats.interfaces[item.Name] = { received, sent };
                                stats.totalReceived += received;
                                stats.totalSent += sent;
                                console.log(`📊 ${item.Name}: RX=${received}, TX=${sent}`);
                            }
                        }
                    }

                    if (stats.totalReceived > 0 || stats.totalSent > 0) {
                        return stats;
                    }
                } catch (parseError) {
                    console.log('Failed to parse all adapters output');
                }
            } catch (allAdaptersError: any) {
                console.log('Failed to get all adapters stats');
            }

            // Final fallback: Use netstat -e (shows combined stats)
            console.warn('⚠️ Falling back to netstat -e (combined stats)');
            return this.getWindowsNetstatFallback();

        } catch (err: any) {
            console.error('Netstat failed, using OS fallback:', err.message);
            return this.getOSNetworkStats();
        }
    }

    private async getWindowsNetstatFallback(): Promise<NetworkStats> {
        try {
            const { stdout } = await execPromise('netstat -e');
            const stats: NetworkStats = {
                totalReceived: 0,
                totalSent: 0,
                interfaces: {}
            };

            const lines = stdout.split('\n');
            for (const line of lines) {
                if (line.includes('Bytes')) {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length >= 3) {
                        const received = parseInt(parts[1].replace(/,/g, '')) || 0;
                        const sent = parseInt(parts[2].replace(/,/g, '')) || 0;

                        stats.interfaces['Combined (netstat -e)'] = { received, sent };
                        stats.totalReceived = received;
                        stats.totalSent = sent;
                        console.log(`📊 Combined stats: RX=${received}, TX=${sent}`);
                    }
                }
            }

            return stats;
        } catch (err: any) {
            console.error('Netstat fallback failed:', err.message);
            return this.getOSNetworkStats();
        }
    }

    // Linux network stats with better parsing
    private async getLinuxNetworkStats(): Promise<NetworkStats> {
        try {
            const { stdout } = await execPromise('cat /proc/net/dev');
            const stats: NetworkStats = {
                totalReceived: 0,
                totalSent: 0,
                interfaces: {}
            };

            const lines = stdout.split('\n');
            for (const line of lines) {
                // Skip header lines and loopback
                if (line.includes('lo') || line.includes('face') || line.includes('bytes')) {
                    continue;
                }

                const parts = line.trim().split(/\s+/);
                if (parts.length >= 17) {
                    const name = parts[0].replace(':', '');
                    // /proc/net/dev format: 
                    // name: bytes packets errs drop fifo frame compressed multicast
                    // bytes packets errs drop fifo colls carrier compressed
                    const received = parseInt(parts[1]) || 0;
                    const sent = parseInt(parts[9]) || 0;

                    if (received > 0 || sent > 0) {
                        stats.interfaces[name] = { received, sent };
                        stats.totalReceived += received;
                        stats.totalSent += sent;
                    }
                }
            }

            return stats;
        } catch (err: any) {
            console.error('Failed to read /proc/net/dev, using OS module:', err.message);
            return this.getOSNetworkStats();
        }
    }

    // macOS network stats
    private async getMacNetworkStats(): Promise<NetworkStats> {
        try {
            // Get all network interfaces
            const { stdout } = await execPromise('ifconfig -u');
            const interfaces = stdout.split('\n\n').filter(iface => iface.trim());

            const stats: NetworkStats = {
                totalReceived: 0,
                totalSent: 0,
                interfaces: {}
            };

            for (const iface of interfaces) {
                const lines = iface.split('\n');
                let name = '';
                let received = 0;
                let sent = 0;

                for (const line of lines) {
                    if (line.includes('flags=') && !line.includes('lo0')) {
                        name = line.split(':')[0] || '';
                    }

                    // Parse bytes (macOS uses different format)
                    if (line.includes('bytes')) {
                        const bytesMatch = line.match(/bytes:(\d+)/);
                        if (bytesMatch) {
                            received = parseInt(bytesMatch[1]) || 0;
                        }
                    }

                    if (line.includes('packets') && line.includes('errs')) {
                        const parts = line.trim().split(/\s+/);
                        if (parts.length >= 10) {
                            sent = parseInt(parts[parts.length - 1]) || 0;
                        }
                    }
                }

                if (name && (received > 0 || sent > 0)) {
                    stats.interfaces[name] = { received, sent };
                    stats.totalReceived += received;
                    stats.totalSent += sent;
                }
            }

            // If no data from ifconfig, try netstat
            if (stats.totalReceived === 0 && stats.totalSent === 0) {
                return this.getMacNetstatStats();
            }

            return stats;
        } catch (err: any) {
            console.error('ifconfig failed, trying netstat:', err.message);
            return this.getMacNetstatStats();
        }
    }

    // Alternative macOS method using netstat
    private async getMacNetstatStats(): Promise<NetworkStats> {
        try {
            const { stdout } = await execPromise('netstat -ibn | grep -v "lo0"');
            const stats: NetworkStats = {
                totalReceived: 0,
                totalSent: 0,
                interfaces: {}
            };

            const lines = stdout.split('\n');
            for (const line of lines) {
                if (line.includes('Link') || line.includes('Name') || !line.trim()) {
                    continue;
                }

                const parts = line.trim().split(/\s+/);
                if (parts.length >= 10) {
                    const name = parts[0];
                    // netstat -ibn format: Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes
                    const received = parseInt(parts[6]) || 0;
                    const sent = parseInt(parts[9]) || 0;

                    stats.interfaces[name] = { received, sent };
                    stats.totalReceived += received;
                    stats.totalSent += sent;
                }
            }

            return stats;
        } catch (err: any) {
            console.error('Netstat failed, using OS fallback:', err.message);
            return this.getOSNetworkStats();
        }
    }

    // Fallback using Node.js OS module with alternative approach
    private getOSNetworkStats(): NetworkStats {
        const stats: NetworkStats = {
            totalReceived: 0,
            totalSent: 0,
            interfaces: {}
        };

        // Use Node.js built-in methods
        const networkInterfaces = os.networkInterfaces();

        // For Windows, try to get stats from WMI through child_process
        if (os.platform() === 'win32') {
            try {
                // Use a simpler approach with wmic
                const { execSync } = require('child_process');
                const output = execSync('wmic path Win32_PerfRawData_Tcpip_NetworkInterface get Name,BytesReceivedPersec,BytesSentPersec', { encoding: 'utf8' });

                const lines = output.split('\n');
                for (const line of lines) {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length >= 3) {
                        const name = parts[0];
                        const received = parseFloat(parts[1]) || 0;
                        const sent = parseFloat(parts[2]) || 0;

                        if (name && !name.includes('Name')) {
                            stats.interfaces[name] = {
                                received: Math.round(received),
                                sent: Math.round(sent)
                            };
                            stats.totalReceived += Math.round(received);
                            stats.totalSent += Math.round(sent);
                        }
                    }
                }
            } catch (err: any) {
                console.error('WMI query failed:', err.message);
            }
        }

        // If still no data, use placeholder with interface names
        if (Object.keys(stats.interfaces).length === 0) {
            for (const [name, iface] of Object.entries(networkInterfaces)) {
                if (iface) {
                    // Check if interface is active
                    const hasIP = iface.some(addr => addr.family === 'IPv4' && !addr.internal);
                    if (hasIP) {
                        stats.interfaces[name] = { received: 0, sent: 0 };
                    }
                }
            }
        }

        return stats;
    }

    // Get process-level network usage
    private async getProcessNetworkUsage(): Promise<ProcessStats> {
        const platform = os.platform();
        const processStats: ProcessStats = {};

        try {
            if (platform === 'win32') {
                const { stdout } = await execPromise('netstat -n -b');
                const lines = stdout.split('\n');
                let currentProcess = 'System';

                for (const line of lines) {
                    if (line.includes('[') && line.includes(']')) {
                        const match = line.match(/\[([^\]]+)\]/);
                        if (match) {
                            currentProcess = match[1];
                        }
                    } else if (line.includes('TCP') || line.includes('UDP')) {
                        if (!processStats[currentProcess]) {
                            processStats[currentProcess] = { connections: 0, type: 'unknown' };
                        }
                        processStats[currentProcess].connections++;
                    }
                }
            } else if (platform === 'linux') {
                const { stdout } = await execPromise('ss -tunp | grep -v "UNCONN"');
                const lines = stdout.split('\n');
                for (const line of lines) {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length >= 6) {
                        const processInfo = parts[parts.length - 1] || 'unknown';
                        const processName = processInfo.includes('users:') ?
                            processInfo.split('(')[1]?.replace(')', '') || 'unknown' :
                            'unknown';

                        if (!processStats[processName]) {
                            processStats[processName] = { connections: 0, type: 'unknown' };
                        }
                        processStats[processName].connections++;
                    }
                }
            } else if (platform === 'darwin') {
                const { stdout } = await execPromise('lsof -i -n -P');
                const lines = stdout.split('\n');
                for (const line of lines) {
                    if (line.includes('TCP') || line.includes('UDP')) {
                        const parts = line.trim().split(/\s+/);
                        if (parts.length >= 2) {
                            const processName = parts[0];
                            if (!processStats[processName]) {
                                processStats[processName] = { connections: 0, type: 'unknown' };
                            }
                            processStats[processName].connections++;
                        }
                    }
                }
            }
        } catch (err: any) {
            console.error('Failed to get process network usage:', err.message);
        }

        return processStats;
    }

    // Calculate current speeds with better accuracy
    private calculateSpeeds(currentStats: NetworkStats): SpeedResult {
        const now = Date.now();
        const elapsed = (now - this.totalUsage.lastUpdate) / 1000; // seconds

        // console.log('📊 Calculating speeds - Elapsed:', elapsed, 'seconds');

        if (elapsed < 0.1) {
            return {
                downloadSpeed: 0,
                uploadSpeed: 0,
                totalReceived: 0,
                totalSent: 0,
                receivedDiff: 0,
                sentDiff: 0
            };
        }

        let downloadSpeed = 0;
        let uploadSpeed = 0;
        let totalReceivedDiff = 0;
        let totalSentDiff = 0;

        // Calculate speed for each interface
        for (const [name, stats] of Object.entries(currentStats.interfaces)) {
            // console.log(`📊 Interface ${name}: received=${stats.received}, sent=${stats.sent}`);

            if (this.interfaces[name]) {
                const prevReceived = this.interfaces[name].lastBytesReceived || 0;
                const prevSent = this.interfaces[name].lastBytesSent || 0;

                const receivedDiff = stats.received - prevReceived;
                const sentDiff = stats.sent - prevSent;

                // console.log(`📊 Diff for ${name}: receivedDiff=${receivedDiff}, sentDiff=${sentDiff}`);

                if (receivedDiff > 0) {
                    downloadSpeed += receivedDiff / elapsed;
                    totalReceivedDiff += receivedDiff;
                }
                if (sentDiff > 0) {
                    uploadSpeed += sentDiff / elapsed;
                    totalSentDiff += sentDiff;
                }

                // Update stored values
                this.interfaces[name].lastBytesReceived = stats.received;
                this.interfaces[name].lastBytesSent = stats.sent;
                this.interfaces[name].speedDown = receivedDiff / elapsed;
                this.interfaces[name].speedUp = sentDiff / elapsed;
            } else {
                // New interface
                this.interfaces[name] = {
                    addresses: [],
                    bytesReceived: 0,
                    bytesSent: 0,
                    lastBytesReceived: stats.received,
                    lastBytesSent: stats.sent,
                    speedDown: 0,
                    speedUp: 0,
                    rxBytes: stats.received,
                    txBytes: stats.sent
                };
            }
        }

        // Update total usage
        const totalReceivedNow = Object.values(currentStats.interfaces).reduce((sum, s) => sum + s.received, 0);
        const totalSentNow = Object.values(currentStats.interfaces).reduce((sum, s) => sum + s.sent, 0);

        const receivedDiff = totalReceivedNow - (this.totalUsage.lastTotalReceived || 0);
        const sentDiff = totalSentNow - (this.totalUsage.lastTotalSent || 0);

        // console.log(`📊 Total: receivedDiff=${receivedDiff}, sentDiff=${sentDiff}`);

        if (receivedDiff > 0) {
            this.totalUsage.downloaded += receivedDiff;
            this.totalUsage.total += receivedDiff;
        }
        if (sentDiff > 0) {
            this.totalUsage.uploaded += sentDiff;
            this.totalUsage.total += sentDiff;
        }

        this.totalUsage.lastTotalReceived = totalReceivedNow;
        this.totalUsage.lastTotalSent = totalSentNow;
        this.totalUsage.lastUpdate = now;

        const result: SpeedResult = {
            downloadSpeed: downloadSpeed > 0 ? downloadSpeed : 0,
            uploadSpeed: uploadSpeed > 0 ? uploadSpeed : 0,
            totalReceived: totalReceivedNow,
            totalSent: totalSentNow,
            receivedDiff: receivedDiff,
            sentDiff: sentDiff
        };

        // console.log('📊 Speed result:', result);
        return result;
    }

    // Format bytes to human readable
    private formatBytes(bytes: number): string {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    // Format speed (bytes/second to Mbps or MB/s)
    private formatSpeed(bytesPerSecond: number): string {
        if (bytesPerSecond === 0) return '0 B/s';

        // Convert to Mbps (megabits per second)
        const mbps = (bytesPerSecond * 8) / (1024 * 1024);
        if (mbps >= 1) {
            return `${mbps.toFixed(2)} Mbps`;
        }

        // Convert to KB/s
        const kbps = bytesPerSecond / 1024;
        if (kbps >= 1) {
            return `${kbps.toFixed(2)} KB/s`;
        }

        return `${bytesPerSecond.toFixed(0)} B/s`;
    }

    // Display current usage
    displayCurrentUsage(speeds: SpeedResult): void {
        const now = new Date();
        const runtime = (now.getTime() - this.totalUsage.startTime.getTime()) / 1000;
        const hours = Math.floor(runtime / 3600);
        const minutes = Math.floor((runtime % 3600) / 60);
        const seconds = Math.floor(runtime % 60);

        console.clear();
        // console.log('═'.repeat(70));
        // console.log('🌐 NETWORK USAGE MONITOR');
        // console.log('═'.repeat(70));
        // console.log(`⏱️ Runtime: ${hours}h ${minutes}m ${seconds}s`);
        // console.log(`🕐 Last Update: ${now.toLocaleTimeString()}`);
        // console.log('─'.repeat(70));

        // Total usage
        // console.log('\n📊 TOTAL USAGE:');
        // console.log(`   📥 Downloaded: ${this.formatBytes(this.totalUsage.downloaded)}`);
        // console.log(`   📤 Uploaded:   ${this.formatBytes(this.totalUsage.uploaded)}`);
        // console.log(`   📦 Total:      ${this.formatBytes(this.totalUsage.total)}`);

        // Current speeds
        // console.log('\n⚡ CURRENT SPEEDS:');
        // console.log(`   📥 Download: ${this.formatSpeed(speeds.downloadSpeed)}`);
        // console.log(`   📤 Upload:   ${this.formatSpeed(speeds.uploadSpeed)}`);

        // This session's data
        // console.log('\n📈 THIS SESSION:');
        // console.log(`   📥 Downloaded: ${this.formatBytes(this.totalUsage.downloaded)}`);
        // console.log(`   📤 Uploaded:   ${this.formatBytes(this.totalUsage.uploaded)}`);

        // Interface details
        // console.log('\n🔌 ACTIVE INTERFACES:');
        let hasActiveInterface = false;
        for (const [name, iface] of Object.entries(this.interfaces)) {
            if (iface.speedDown > 0 || iface.speedUp > 0 || iface.lastBytesReceived > 0 || iface.lastBytesSent > 0) {
                hasActiveInterface = true;
                // console.log(`   ${name}:`);
                // console.log(`      📥 Down: ${this.formatSpeed(iface.speedDown)}`);
                // console.log(`      📤 Up:   ${this.formatSpeed(iface.speedUp)}`);
                // console.log(`      📊 Total RX: ${this.formatBytes(iface.lastBytesReceived)}`);
                // console.log(`      📊 Total TX: ${this.formatBytes(iface.lastBytesSent)}`);
                if (iface.addresses.length > 0) {
                    // console.log(`      🏠 IP:   ${iface.addresses.join(', ')}`);
                }
            }
        }
        if (!hasActiveInterface) {
            // console.log('   No active interfaces detected');
        }

        // Top applications (if available)
        // console.log('\n📱 TOP APPLICATIONS:');
        const sortedProcesses = Object.entries(this.processStats)
            .sort((a, b) => b[1].connections - a[1].connections)
            .slice(0, 5);

        if (sortedProcesses.length > 0) {
            for (const [name, stats] of sortedProcesses) {
                if (name !== 'unknown') {
                    // console.log(`   ${name}: ${stats.connections} active connections`);
                }
            }
        } else {
            // console.log('   No application data available');
        }

        // Daily usage stats
        const dailyStats = this.getDailyStats();
        if (dailyStats) {
            // console.log('\n📅 TODAY\'S USAGE:');
            // console.log(`   📥 Downloaded: ${this.formatBytes(dailyStats.downloaded)}`);
            // console.log(`   📤 Uploaded:   ${this.formatBytes(dailyStats.uploaded)}`);
            // console.log(`   📦 Total:      ${this.formatBytes(dailyStats.total)}`);

            // Projection
            const nowDate = new Date();
            const startOfDay = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate());
            const hoursToday = (nowDate.getTime() - startOfDay.getTime()) / (1000 * 60 * 60);
            if (hoursToday > 0) {
                const projectedTotal = (dailyStats.total / hoursToday) * 24;
                // console.log(`   📊 Projected daily total: ${this.formatBytes(projectedTotal)}`);
            }
        }

        // console.log('\n' + '═'.repeat(70));
        // console.log('🔄 Press Ctrl+C to stop monitoring');
        // console.log('═'.repeat(70));
    }

    // Get daily usage stats from history
    private getDailyStats(): DailyStats | null {
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

        let downloaded = 0;
        let uploaded = 0;

        for (const entry of this.history) {
            const entryDate = new Date(entry.timestamp).getTime();
            if (entryDate >= today) {
                downloaded += entry.downloaded || 0;
                uploaded += entry.uploaded || 0;
            }
        }

        // Add current session
        downloaded += this.totalUsage.downloaded;
        uploaded += this.totalUsage.uploaded;

        return {
            downloaded,
            uploaded,
            total: downloaded + uploaded
        };
    }

    // Save current session to history
    private saveSessionToHistory(): void {
        const entry: HistoryEntry = {
            timestamp: new Date().toISOString(),
            downloaded: this.totalUsage.downloaded,
            uploaded: this.totalUsage.uploaded,
            total: this.totalUsage.total,
            duration: (Date.now() - this.totalUsage.startTime.getTime()) / 1000
        };

        this.history.push(entry);
        this.saveHistory();
    }

    // Update loop
    private async update(): Promise<void> {
        try {
            const stats = await this.getNetworkStats();
            // console.log('📊 Raw stats from system:', JSON.stringify(stats, null, 2));

            const speeds = this.calculateSpeeds(stats);
            console.log('📊 Calculated speeds:', speeds);

            // Get process stats (can be slow, do every 10th update)
            if (Math.floor(Date.now() / 1000) % 10 === 0) {
                this.processStats = await this.getProcessNetworkUsage();
            }

            // this.displayCurrentUsage(speeds);

            // Save to history every 5 minutes
            if (this.totalUsage.downloaded > 0 || this.totalUsage.uploaded > 0) {
                // Only save if there's significant activity
                this.saveSessionToHistory();
            }
        } catch (err: any) {
            console.error('Update error:', err.message);
        }
    }

    // Start monitoring
    public async start(): Promise<void> {
        if (this.isRunning) {
            // console.log('Monitor already running');
            return;
        }

        // console.log('🌐 Starting Network Usage Monitor...');
        // console.log('═'.repeat(70));

        // Get initial stats
        const initialStats = await this.getNetworkStats();
        // console.log('📊 Initial stats:', initialStats);

        this.totalUsage.lastTotalReceived = Object.values(initialStats.interfaces).reduce((sum, s) => sum + s.received, 0);
        this.totalUsage.lastTotalSent = Object.values(initialStats.interfaces).reduce((sum, s) => sum + s.sent, 0);
        this.totalUsage.lastUpdate = Date.now();

        // Initialize interface stats
        for (const [name, stats] of Object.entries(initialStats.interfaces)) {
            if (!this.interfaces[name]) {
                this.interfaces[name] = {
                    addresses: [],
                    bytesReceived: 0,
                    bytesSent: 0,
                    lastBytesReceived: stats.received,
                    lastBytesSent: stats.sent,
                    speedDown: 0,
                    speedUp: 0,
                    rxBytes: stats.received,
                    txBytes: stats.sent
                };
            } else {
                this.interfaces[name].lastBytesReceived = stats.received;
                this.interfaces[name].lastBytesSent = stats.sent;
            }
        }

        this.isRunning = true;

        // Update every second
        this.updateInterval = setInterval(() => {
            this.update();
        }, 1000);

        // Save history every minute
        this.saveInterval = setInterval(() => {
            this.saveSessionToHistory();
        }, 60000);

        // Handle Ctrl+C
        process.on('SIGINT', () => {
            this.stop();
        });
    }

    // Stop monitoring
    public stop(): void {
        if (!this.isRunning) return;

        // console.log('\n🛑 Stopping monitor...');
        this.isRunning = false;

        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
        if (this.saveInterval) {
            clearInterval(this.saveInterval);
            this.saveInterval = null;
        }

        // Save final session
        this.saveSessionToHistory();

        // console.log('📊 Final Summary:');
        // console.log(`   📥 Total Downloaded: ${this.formatBytes(this.totalUsage.downloaded)}`);
        // console.log(`   📤 Total Uploaded:   ${this.formatBytes(this.totalUsage.uploaded)}`);
        // console.log(`   📦 Total Data:       ${this.formatBytes(this.totalUsage.total)}`);
        // console.log(`   ⏱️ Session Duration:  ${Math.floor((Date.now() - this.totalUsage.startTime.getTime()) / 1000)} seconds`);

        // console.log('\n✅ Monitor stopped. Data saved to history.');
        process.exit(0);
    }

    // Show historical stats
    public showHistory(): void {
        const totalDownloads = this.history.reduce((sum, entry) => sum + entry.downloaded, 0);
        const totalUploads = this.history.reduce((sum, entry) => sum + entry.uploaded, 0);
        const totalData = totalDownloads + totalUploads;

        // console.log('\n📊 NETWORK USAGE HISTORY');
        // console.log('═'.repeat(60));
        // console.log(`📝 Total Entries: ${this.history.length}`);
        // console.log(`📥 Total Downloaded: ${this.formatBytes(totalDownloads)}`);
        // console.log(`📤 Total Uploaded:   ${this.formatBytes(totalUploads)}`);
        // console.log(`📦 Total Data Used:  ${this.formatBytes(totalData)}`);

        if (this.history.length > 0) {
            const avgDownload = totalDownloads / this.history.length;
            const avgUpload = totalUploads / this.history.length;
            // console.log(`\n📊 Average Per Session:`);
            // console.log(`   📥 Download: ${this.formatBytes(avgDownload)}`);
            // console.log(`   📤 Upload:   ${this.formatBytes(avgUpload)}`);

            // Last 10 sessions
            // console.log('\n📋 Last 10 Sessions:');
            const last10 = this.history.slice(-10).reverse();
            for (const entry of last10) {
                const date = new Date(entry.timestamp).toLocaleString();
                // console.log(`   ${date}: ↓${this.formatBytes(entry.downloaded)} ↑${this.formatBytes(entry.uploaded)}`);
            }
        }
        // console.log('═'.repeat(60));
    }

    public getReport(): {
        uploaded: string
        downloaded: string
        total: string
    } {

        return {
            downloaded: this.formatBytes(this.totalUsage.downloaded),
            uploaded: this.formatBytes(this.totalUsage.uploaded),
            total: this.formatBytes(this.totalUsage.total)
        }
    }
}

// CLI Interface
if (require.main === module) {
    const args = process.argv.slice(2);
    const monitor = new NetworkMonitor();

    if (args.includes('--history') || args.includes('-h')) {
        monitor.showHistory();
    } else if (args.includes('--help')) {
        console.log(`
Usage: node network-monitor.js [options]

Options:
  --history, -h    Display historical usage summary
  --help           Show this help message

Examples:
  node network-monitor.js           Start monitoring network usage
  node network-monitor.js --history Show historical usage
  node network-monitor.js --help    Show this help

Note: Press Ctrl+C to stop monitoring and save data
        `);
    } else {
        monitor.start().catch(console.error);
    }
}

export default NetworkMonitor;