#!/usr/bin/env node

/**
 * Event Horizon Tile Server Helper
 * Simple command-line interface for managing the tile server
 */

const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs-extra');

const SERVER_NAME = 'tile-server';
const SCRIPT_DIR = __dirname;

// Colors for console output
const colors = {
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    reset: '\x1b[0m'
};

function log(message, color = 'reset') {
    console.log(`${colors[color]}${message}${colors.reset}`);
}

function printUsage() {
    log('Event Horizon Tile Server Helper', 'blue');
    console.log('');
    console.log('Usage: node tile-helper.js [command] [options]');
    console.log('');
    console.log('Server Management:');
    console.log('  start         Start the tile server');
    console.log('  stop          Stop the tile server');
    console.log('  restart       Restart the tile server');
    console.log('  status        Show server status');
    console.log('  logs          Show server logs');
    console.log('  health        Check server health');
    console.log('');
    console.log('Processing Commands:');
    console.log('  process <file> [options]  Process a TIFF file');
    console.log('  quick <file>              Quick process (max-zoom 6)');
    console.log('  full <file>               Full process (max-zoom 12)');
    console.log('');
    console.log('Examples:');
    console.log('  node tile-helper.js start');
    console.log('  node tile-helper.js quick data/pollution.tif');
    console.log('  node tile-helper.js process data/pollution.tif --max-zoom 8');
}

function runCommand(command, args = [], options = {}) {
    return new Promise((resolve, reject) => {
        const proc = spawn(command, args, {
            stdio: options.silent ? 'pipe' : 'inherit',
            cwd: SCRIPT_DIR,
            ...options
        });

        let stdout = '';
        let stderr = '';

        if (options.silent) {
            proc.stdout.on('data', (data) => {
                stdout += data.toString();
            });
            proc.stderr.on('data', (data) => {
                stderr += data.toString();
            });
        }

        proc.on('close', (code) => {
            if (code === 0) {
                resolve({ stdout, stderr, code });
            } else {
                reject(new Error(`Command failed with exit code ${code}: ${stderr}`));
            }
        });
    });
}

async function serverStart() {
    log('Starting tile server...', 'blue');
    
    try {
        // Check if already running
        await runCommand('pm2', ['describe', SERVER_NAME], { silent: true });
        log('Server is already running', 'yellow');
        return;
    } catch (error) {
        // Server not running, start it
    }

    try {
        await runCommand('pm2', ['start', 'src/server.js', '--name', SERVER_NAME, '--time']);
        await runCommand('pm2', ['startup'], { silent: true });
        await runCommand('pm2', ['save'], { silent: true });
        
        log('✓ Server started successfully', 'green');
        setTimeout(() => serverStatus(), 2000);
    } catch (error) {
        log(`✗ Failed to start server: ${error.message}`, 'red');
    }
}

async function serverStop() {
    log('Stopping tile server...', 'blue');
    
    try {
        await runCommand('pm2', ['stop', SERVER_NAME]);
        await runCommand('pm2', ['delete', SERVER_NAME]);
        log('✓ Server stopped', 'green');
    } catch (error) {
        log(`✗ Failed to stop server: ${error.message}`, 'red');
    }
}

async function serverRestart() {
    log('Restarting tile server...', 'blue');
    
    try {
        await runCommand('pm2', ['restart', SERVER_NAME]);
        log('✓ Server restarted', 'green');
        setTimeout(() => serverStatus(), 2000);
    } catch (error) {
        log(`✗ Failed to restart server: ${error.message}`, 'red');
    }
}

async function serverStatus() {
    log('Server Status:', 'blue');
    
    try {
        await runCommand('pm2', ['describe', SERVER_NAME]);
    } catch (error) {
        log('✗ Server is not running', 'red');
    }
}

async function serverLogs() {
    log('Showing server logs (Ctrl+C to exit):', 'blue');
    
    try {
        await runCommand('pm2', ['logs', SERVER_NAME]);
    } catch (error) {
        log(`✗ Failed to show logs: ${error.message}`, 'red');
    }
}

async function serverHealth() {
    log('Checking server health...', 'blue');
    
    try {
        const response = await fetch('http://localhost:3001/health');
        if (response.ok) {
            const data = await response.json();
            log('✓ Server is healthy', 'green');
            console.log(JSON.stringify(data, null, 2));
        } else {
            log(`✗ Server health check failed (HTTP ${response.status})`, 'red');
        }
    } catch (error) {
        log(`✗ Health check failed: ${error.message}`, 'red');
    }
}

async function processTiff(file, ...options) {
    if (!file) {
        log('Error: No file specified', 'red');
        printUsage();
        process.exit(1);
    }

    const filePath = path.resolve(file);
    if (!await fs.pathExists(filePath)) {
        log(`Error: File '${file}' not found`, 'red');
        process.exit(1);
    }

    log(`Processing TIFF file: ${file}`, 'blue');
    log(`Options: ${options.join(' ')}`, 'blue');
    console.log('');

    try {
        await runCommand('node', ['scripts/process-tiff.js', file, ...options]);
        log('✓ Processing completed successfully', 'green');
    } catch (error) {
        log(`✗ Processing failed: ${error.message}`, 'red');
        process.exit(1);
    }
}

async function quickProcess(file) {
    log(`Quick processing: ${file}`, 'yellow');
    await processTiff(file, '--force-web-mercator', '--max-zoom', '6', '--processes', '4');
}

async function fullProcess(file) {
    log(`Full processing: ${file}`, 'yellow');
    await processTiff(file, '--force-web-mercator', '--max-zoom', '12', '--processes', '4');
}

// Main execution
async function main() {
    const [,, command, ...args] = process.argv;

    if (!command) {
        printUsage();
        process.exit(1);
    }

    try {
        switch (command) {
            case 'start':
                await serverStart();
                break;
            case 'stop':
                await serverStop();
                break;
            case 'restart':
                await serverRestart();
                break;
            case 'status':
                await serverStatus();
                break;
            case 'logs':
                await serverLogs();
                break;
            case 'health':
                await serverHealth();
                break;
            case 'process':
                await processTiff(...args);
                break;
            case 'quick':
                await quickProcess(args[0]);
                break;
            case 'full':
                await fullProcess(args[0]);
                break;
            default:
                log(`Unknown command: ${command}`, 'red');
                printUsage();
                process.exit(1);
        }
    } catch (error) {
        log(`Error: ${error.message}`, 'red');
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    serverStart,
    serverStop,
    serverRestart,
    serverStatus,
    processTiff,
    quickProcess,
    fullProcess
};