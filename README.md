# Antigravity Quota Status Bar Extension

A real-time model quota telemetry extension for Google Antigravity IDE and VS Code.

---

## Overview

The **Antigravity Quota Status Bar Extension** delivers continuous, low-latency model capacity monitoring directly within the editor status bar. Built specifically for Google Antigravity IDE and VS Code, it queries the local language server process over loopback IPC/RPC to provide accurate remaining capacity metrics without interrupting developer workflow.

---

## Key Features

### Dual-Group Model Telemetry
Monitors capacity across both primary Antigravity model pools independently:
- **Gemini Model Pool:** Tracks remaining capacity for Gemini 3.8/3.7/3.6 Flash and Gemini 3.1 Pro models.
- **Third-Party Model Pool:** Tracks remaining capacity for third-party models (Claude 3.7/3.5 Sonnet, Claude Opus 4.6, and GPT-OSS).

### Zero AI Token Consumption
Communicates strictly via local HTTPS IPC endpoints (`127.0.0.1`) on the host machine. It does not invoke external LLM APIs and consumes zero prompt or completion tokens.

### Interactive Telemetry Dashboard
Selecting the status bar item opens a detailed telemetry panel displaying:
- **Capacity Ratios:** Remaining fraction vs. consumed capacity.
- **Reset Timestamps:** Exact local time and relative countdown until quota replenishment.
- **Subscription Tier Status:** Active plan verification (*Pro*, *Ultra*, or *Teams*).
- **RPC Diagnostics:** Active local port and host loopback diagnostics.

### Caching and Automated Recovery
- **Low-Latency Polling:** Caches active RPC server ports in memory to execute background updates in less than 5 milliseconds.
- **Automatic Recovery:** Re-scans background process trees or parses local runtime logs (`main.log`) if the language server process restarts.

---

## Technical Specifications

| Parameter | Specification |
| :--- | :--- |
| **Supported Platforms** | Google Antigravity IDE, VS Code (1.75.0+) |
| **Operating Systems** | Windows 10/11, macOS (Apple Silicon & Intel), Linux |
| **Refresh Interval** | 60-second background cycle + manual click-to-refresh |
| **Resource Overhead** | Under 10 MB RAM, under 0.1% CPU |

---

## Scope and Boundaries

> [!NOTE]
> **Backend Quota Aggregation**  
> Google Antigravity aggregates rate limits server-side into a single `remainingFraction` and `resetTime` payload per model. This extension accurately reflects all backend quota metrics exposed by the running language server process.

---

## Installation Guide

### VSIX Package Installation (Recommended)

1. Download `antigravity-quota-indicator-1.0.0.vsix`.
2. Open **Antigravity IDE** or **VS Code**.
3. Open the **Extensions** panel (`Ctrl+Shift+X` or `Cmd+Shift+X`).
4. Select the **More Actions** (`...`) menu at the top-right of the Extensions pane.
5. Click **Install from VSIX...** and select the downloaded file.
6. Open the Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`) and select **Developer: Reload Window**.

---

## License

Distributed under the **MIT License**. Free for personal and commercial use.
