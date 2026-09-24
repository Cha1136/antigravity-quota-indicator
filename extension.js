const vscode = require('vscode');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

let statusBarItem;
let updateInterval;
let cachedCandidate = null;
let lastQuotaData = null;

function getLogPath() {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    let candidatePaths = [];
    if (process.platform === 'win32') {
        const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
        candidatePaths = [
            path.join(appData, 'Antigravity', 'logs', 'main.log'),
            path.join(appData, 'antigravity', 'logs', 'main.log'),
            path.join(home, '.gemini', 'antigravity', 'logs', 'main.log'),
            path.join(home, '.gemini', 'antigravity-ide', 'logs', 'main.log')
        ];
    } else if (process.platform === 'darwin') {
        candidatePaths = [
            path.join(home, 'Library', 'Application Support', 'Antigravity', 'logs', 'main.log'),
            path.join(home, 'Library', 'Application Support', 'antigravity', 'logs', 'main.log'),
            path.join(home, 'Library', 'Logs', 'Antigravity', 'main.log'),
            path.join(home, '.gemini', 'antigravity', 'logs', 'main.log'),
            path.join(home, '.gemini', 'antigravity-ide', 'logs', 'main.log')
        ];
    } else {
        candidatePaths = [
            path.join(home, '.config', 'Antigravity', 'logs', 'main.log'),
            path.join(home, '.config', 'antigravity', 'logs', 'main.log'),
            path.join(home, '.gemini', 'antigravity', 'logs', 'main.log')
        ];
    }
    for (const p of candidatePaths) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function parseLog(logPath) {
    if (!logPath || !fs.existsSync(logPath)) return { ports: [], csrfToken: null };
    try {
        const content = fs.readFileSync(logPath, 'utf8');
        const lines = content.split(/\r?\n/).slice(-500);
        const ports = [];
        let csrfToken = null;
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i];
            const matches = line.matchAll(/(?:https?:\/\/127\.0\.0\.1:|127\.0\.0\.1:|localhost:)(\d+)/g);
            for (const match of matches) {
                const p = match[1];
                if (p && !ports.includes(p)) ports.push(p);
            }
            if (!csrfToken) {
                const csrfMatch = line.match(/--csrf_token\s+([a-f0-9\-]{36})/);
                if (csrfMatch) csrfToken = csrfMatch[1];
            }
        }
        return { ports, csrfToken };
    } catch (e) {
        return { ports: [], csrfToken: null };
    }
}

function findCandidatesAsync() {
    return new Promise((resolve) => {
        if (process.platform === 'win32') {
            const psCmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name like '%language_server%'\\" | Select-Object ProcessId, CommandLine | ConvertTo-Json"`;
            exec(psCmd, { timeout: 12000 }, (err, stdout) => {
                if (err || !stdout || !stdout.trim()) return resolve(fallbackLogCandidates());
                try {
                    const procs = JSON.parse(stdout.trim());
                    const procList = Array.isArray(procs) ? procs : [procs];
                    const pids = procList.map(p => p.ProcessId).filter(Boolean);
                    if (pids.length === 0) return resolve(fallbackLogCandidates());

                    const netCmd = `powershell -NoProfile -Command "Get-NetTCPConnection -OwningProcess ${pids.join(',')} -State Listen | Select-Object OwningProcess, LocalPort | ConvertTo-Json"`;
                    exec(netCmd, { timeout: 12000 }, (err2, netOut) => {
                        if (err2 || !netOut || !netOut.trim()) return resolve(fallbackLogCandidates());
                        try {
                            const netObjs = JSON.parse(netOut.trim());
                            const netList = Array.isArray(netObjs) ? netObjs : [netObjs];
                            const candidates = [];
                            for (const n of netList) {
                                const proc = procList.find(p => p.ProcessId === n.OwningProcess);
                                if (proc && proc.CommandLine) {
                                    const csrfMatch = proc.CommandLine.match(/--csrf_token\s+([a-f0-9\-]{36})/i);
                                    if (csrfMatch) {
                                        candidates.push({ port: String(n.LocalPort), csrfToken: csrfMatch[1] });
                                    }
                                }
                            }
                            resolve(candidates.length > 0 ? candidates : fallbackLogCandidates());
                        } catch (e) { resolve(fallbackLogCandidates()); }
                    });
                } catch (e) { resolve(fallbackLogCandidates()); }
            });
            return;
        }

        // POSIX (macOS / Linux)
        exec('ps aux | grep -i language_server | grep -v grep', { timeout: 8000 }, (err, stdout) => {
            if (err || !stdout) return resolve(fallbackLogCandidates());
            const lines = stdout.split('\n');
            const candidates = [];
            for (const line of lines) {
                const csrfMatch = line.match(/--csrf_token\s+([a-f0-9\-]{36})/i);
                const pidMatch = line.trim().match(/^\S+\s+(\d+)/);
                if (csrfMatch && pidMatch) {
                    const csrfToken = csrfMatch[1];
                    const pid = pidMatch[1];
                    try {
                        const lsof = execSync(`lsof -a -p ${pid} -i -P -n | grep LISTEN`, { encoding: 'utf8', timeout: 3000 });
                        const portMatches = lsof.match(/:(\d+)\s+\(LISTEN\)/g);
                        if (portMatches) {
                            for (const pm of portMatches) {
                                candidates.push({ port: pm.match(/:(\d+)/)[1], csrfToken });
                            }
                        }
                    } catch (e) {}
                }
            }
            resolve(candidates.length > 0 ? candidates : fallbackLogCandidates());
        });
    });
}

function fallbackLogCandidates() {
    const logPath = getLogPath();
    const logResult = parseLog(logPath);
    const candidates = [];
    if (logResult.ports.length > 0 && logResult.csrfToken) {
        for (const port of logResult.ports) {
            candidates.push({ port, csrfToken: logResult.csrfToken });
        }
    }
    return candidates;
}

function fetchUserStatus(port, csrfToken, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({});
        const req = https.request({
            hostname: host,
            port: port,
            path: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
            method: 'POST',
            rejectUnauthorized: false,
            headers: {
                'Content-Type': 'application/json',
                'x-codeium-csrf-token': csrfToken,
                'Content-Length': Buffer.byteLength(postData)
            }
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(new Error("Parse JSON error"));
                    }
                } else {
                    reject(new Error(`HTTP ${res.statusCode}`));
                }
            });
        });
        req.on('error', (err) => reject(err));
        req.setTimeout(5000, () => { req.destroy(); reject(new Error("Timeout")); });
        req.write(postData);
        req.end();
    });
}

function formatResetTime(resetValue) {
    if (!resetValue) return "unknown";
    try {
        const resetDate = new Date(resetValue);
        const now = new Date();
        const diffMs = resetDate - now;
        if (diffMs <= 0) return "Active (now)";

        const diffMins = Math.round(diffMs / 60000);
        let relStr = "";
        if (diffMins < 60) {
            relStr = `${diffMins}m`;
        } else {
            const h = Math.floor(diffMins / 60);
            const m = diffMins % 60;
            relStr = `${h}h ${m}m`;
        }
        const localTimeStr = resetDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return `${localTimeStr} (in ${relStr})`;
    } catch (e) {
        return String(resetValue);
    }
}

async function updateQuotaDisplay() {
    try {
        let response = null;
        let activePort = null;

        // Try cached candidate first
        if (cachedCandidate) {
            try {
                response = await fetchUserStatus(cachedCandidate.port, cachedCandidate.csrfToken);
                activePort = cachedCandidate.port;
            } catch (e) {
                cachedCandidate = null; // Cache invalidated
            }
        }

        // If no cached connection succeeded, find fresh candidates
        if (!response) {
            const candidates = await findCandidatesAsync();
            for (const cand of candidates) {
                try {
                    response = await fetchUserStatus(cand.port, cand.csrfToken);
                    activePort = cand.port;
                    cachedCandidate = cand; // Save valid candidate to cache
                    break;
                } catch (e) {}
            }
        }

        if (!response) {
            statusBarItem.text = `$(warning) Quota: Offline`;
            statusBarItem.tooltip = `Could not connect to local Antigravity Language Server RPC. Click to retry.`;
            return null;
        }

        const userStatus = response.userStatus || response;
        const planName = userStatus?.planStatus?.planInfo?.planName || "Pro";
        const modelConfigs = userStatus?.cascadeModelConfigData?.clientModelConfigs || [];

        let geminiQuota = { remaining: 1, reset: null };
        let thirdPartyQuota = { remaining: 1, reset: null };

        for (const config of modelConfigs) {
            const label = (config.label || config.modelId || "").toLowerCase();
            const quota = config.quotaInfo;
            if (!quota) continue;
            const rem = typeof quota.remainingFraction === 'number' ? quota.remainingFraction : 1;
            const reset = quota.resetTime;

            if (label.includes('gemini')) {
                if (rem < geminiQuota.remaining) geminiQuota.remaining = rem;
                if (reset && !geminiQuota.reset) geminiQuota.reset = reset;
            } else if (label.includes('claude') || label.includes('gpt')) {
                if (rem < thirdPartyQuota.remaining) thirdPartyQuota.remaining = rem;
                if (reset && !thirdPartyQuota.reset) thirdPartyQuota.reset = reset;
            }
        }

        const geminiPct = Math.round((1 - geminiQuota.remaining) * 100);
        const thirdPartyPct = Math.round((1 - thirdPartyQuota.remaining) * 100);

        const geminiRemPct = 100 - geminiPct;
        const thirdPartyRemPct = 100 - thirdPartyPct;

        lastQuotaData = {
            geminiPct,
            thirdPartyPct,
            geminiRemPct,
            thirdPartyRemPct,
            geminiReset: formatResetTime(geminiQuota.reset),
            thirdPartyReset: formatResetTime(thirdPartyQuota.reset),
            planName,
            port: activePort
        };

        statusBarItem.text = `🟣 Gemini: ${geminiRemPct}% | 🟠 Third-Party: ${thirdPartyRemPct}%`;
        statusBarItem.tooltip = `Antigravity Quota (${planName})\nGemini: ${geminiRemPct}% remaining (Resets ${lastQuotaData.geminiReset})\nThird-Party: ${thirdPartyRemPct}% remaining (Resets ${lastQuotaData.thirdPartyReset})\nClick for details & instant refresh`;

        return lastQuotaData;
    } catch (e) {
        statusBarItem.text = `$(warning) Quota: Error`;
        statusBarItem.tooltip = `Error fetching quota: ${e.message}. Click to retry.`;
        return null;
    }
}

async function showQuotaDetailsCommand() {
    vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Refreshing Antigravity Quota...",
        cancellable: false
    }, async () => {
        cachedCandidate = null; // Force fresh check on manual click
        const data = await updateQuotaDisplay();
        if (!data) {
            vscode.window.showErrorMessage("Could not connect to Antigravity Language Server RPC. Is Antigravity running?");
            return;
        }

        const items = [
            {
                label: `🟣 Gemini Models: ${data.geminiRemPct}% remaining (${data.geminiPct}% used)`,
                description: `Resets at ${data.geminiReset}`,
                detail: `Model Pool: Gemini 3.6/3.7/3.8 Flash, 3.1 Pro`
            },
            {
                label: `🟠 Third-Party Models: ${data.thirdPartyRemPct}% remaining (${data.thirdPartyPct}% used)`,
                description: `Resets at ${data.thirdPartyReset}`,
                detail: `Model Pool: Claude 3.7/3.5 Sonnet, Opus 4.6, GPT-OSS`
            },
            {
                label: `💳 Plan: ${data.planName} Tier`,
                description: `Status: ✅ Quotas Healthy`,
                detail: `Connected via Localhost RPC Port: ${data.port}`
            },
            {
                label: `🔄 Click to Refresh Now`,
                description: `Auto-refreshes every 60 seconds (0 AI tokens consumed)`,
                detail: `Last updated: ${new Date().toLocaleTimeString()}`
            }
        ];

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: `Antigravity Model Quotas (${data.planName} Tier)`
        });

        if (selected && selected.label.includes("Refresh Now")) {
            showQuotaDetailsCommand();
        }
    });
}

function activate(context) {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'antigravityQuota.showDetails';
    statusBarItem.text = `$(sync~spin) Quota: Syncing...`;
    statusBarItem.tooltip = `Connecting to Antigravity Language Server...`;
    statusBarItem.show();

    const commandDisposable = vscode.commands.registerCommand('antigravityQuota.showDetails', showQuotaDetailsCommand);
    context.subscriptions.push(statusBarItem);
    context.subscriptions.push(commandDisposable);

    // Initial update
    updateQuotaDisplay();

    // 60-second background refresh interval
    updateInterval = setInterval(() => {
        updateQuotaDisplay();
    }, 60000);
}

function deactivate() {
    if (updateInterval) {
        clearInterval(updateInterval);
    }
}

module.exports = {
    activate,
    deactivate
};
