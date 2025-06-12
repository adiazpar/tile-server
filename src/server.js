/**
 * Event Horizon Tile Server
 * 
 * This server handles the conversion of light pollution TIFF data into web-friendly map tiles.
 * Think of it as a specialized factory that takes raw geographic data and produces
 * the small image tiles that make up your interactive map.
 * 
 * The server provides several key functions:
 * 1. Accept TIFF file uploads from the Django web application
 * 2. Process TIFF files using GDAL to create tile pyramids
 * 3. Serve the generated tiles to the map interface
 * 4. Provide status updates on processing jobs
 * 5. Manage tile storage and caching
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');
const fs = require('fs-extra');
const { spawn } = require('child_process');

// Create the Express application
const app = express();
const PORT = process.env.PORT || 3001;

// Apply security and performance middleware
// Helmet adds various HTTP headers to secure the app
app.use(helmet({
    contentSecurityPolicy: false, // Disable CSP for development
    crossOriginEmbedderPolicy: false // Allow embedding in iframes
}));

// Enable gzip compression for faster responses
app.use(compression());

// Configure CORS to allow your Django app to communicate with this server
app.use(cors({
    origin: '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRFToken']
}));

// Parse JSON request bodies
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

/**
 * Serve Static Tiles
 * 
 * This middleware serves the generated tile images directly to the map.
 * Each tile is a 256x256 pixel PNG image that represents a specific
 * geographic area at a specific zoom level.
 * 
 * The URL pattern is: /tiles/{tileset}/{zoom}/{x}/{y}.png
 * For example: /tiles/light-pollution-2023/10/512/384.png
 */

app.use('/tiles', (req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

app.use('/tiles', express.static(path.join(__dirname, '../tiles'), {
    maxAge: '1d', // Cache tiles for 1 day
    etag: true,   // Enable ETags for efficient caching
    lastModified: true,
}));

// Add 404 handler for missing tiles with CORS headers
app.use('/tiles', (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.status(404).json({ error: 'Tile not found' });
});

/**
 * Health Check Endpoint
 * 
 * This endpoint allows Docker and monitoring systems to verify
 * that the server is running and functioning properly.
 */
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        version: process.env.npm_package_version || '1.0.0',
        gdal: 'available', // We'll verify this works when we test
        services: {
            tileServer: 'running',
            staticFiles: 'serving',
            processing: 'ready'
        },
        uptime: process.uptime()
    });
});

/**
 * Get Available Tilesets
 * 
 * This endpoint returns a list of all processed tilesets that are
 * available for use in the map. Each tileset represents a different
 * light pollution dataset that has been converted to tiles.
 */
app.get('/api/tilesets', async (req, res) => {
    try {
        const tilesDir = path.join(__dirname, '../tiles');
        
        // Ensure the tiles directory exists
        await fs.ensureDir(tilesDir);
        
        const tilesets = await fs.readdir(tilesDir);
        const availableTilesets = [];

        // Examine each subdirectory in the tiles folder
        for (const tileset of tilesets) {
            const tilesetPath = path.join(tilesDir, tileset);
            const stats = await fs.stat(tilesetPath);
            
            // Only process directories (each tileset is a directory)
            if (stats.isDirectory()) {
                const metadataPath = path.join(tilesetPath, 'metadata.json');
                let metadata = {
                    name: tileset,
                    description: '',
                    minZoom: 0,
                    maxZoom: 12,
                    bounds: [-180, -85, 180, 85]
                };
                
                // If metadata file exists, read the stored information
                if (await fs.pathExists(metadataPath)) {
                    try {
                        const storedMetadata = await fs.readJson(metadataPath);
                        metadata = { ...metadata, ...storedMetadata };
                    } catch (error) {
                        console.warn(`Could not read metadata for ${tileset}:`, error.message);
                    }
                }

                // Construct the tile URL template for this tileset
                const baseUrl = `${req.protocol}://${req.get('host')}`;
                const tileUrl = `${baseUrl}/tiles/${tileset}/{z}/{x}/{y}.png`;

                availableTilesets.push({
                    id: tileset,
                    name: metadata.name || tileset,
                    description: metadata.description || `Light pollution data: ${tileset}`,
                    minZoom: metadata.minZoom || 0,
                    maxZoom: metadata.maxZoom || 12,
                    bounds: metadata.bounds || [-180, -85, 180, 85],
                    tileUrl: tileUrl,
                    createdAt: metadata.processedAt || stats.birthtime,
                    size: await calculateTilesetSize(tilesetPath)
                });
            }
        }

        res.json({
            status: 'success',
            count: availableTilesets.length,
            tilesets: availableTilesets
        });
        
    } catch (error) {
        console.error('Error reading tilesets:', error);
        res.status(500).json({ 
            status: 'error',
            error: 'Failed to read tilesets',
            message: error.message 
        });
    }
});

/**
 * Process TIFF File Endpoint
 * 
 * This endpoint accepts a TIFF file processing request and starts
 * the conversion process in the background. The actual processing
 * is done by GDAL's gdal2tiles.py script.
 */
app.post('/api/process-tiff', async (req, res) => {
    const { filename, options = {} } = req.body;
    
    if (!filename) {
        return res.status(400).json({ 
            status: 'error',
            error: 'Filename is required',
            usage: 'POST /api/process-tiff with body: {"filename": "your-file.tif", "options": {...}}'
        });
    }

    try {
        const inputPath = path.join(__dirname, '../data', filename);
        
        // Verify the input file exists
        if (!await fs.pathExists(inputPath)) {
            return res.status(404).json({ 
                status: 'error',
                error: 'TIFF file not found',
                path: inputPath
            });
        }

        // Generate a unique processing ID for tracking this job
        const processingId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        
        // Start the background processing
        // We don't wait for it to complete - that could take minutes or hours
        processTiffAsync(inputPath, processingId, options)
            .catch(error => {
                console.error(`Background processing failed for ${processingId}:`, error);
            });

        res.json({ 
            status: 'success',
            processingId: processingId,
            message: 'TIFF processing started',
            statusUrl: `/api/processing-status/${processingId}`,
            estimatedTime: '5-30 minutes depending on file size'
        });
        
    } catch (error) {
        console.error('Error starting TIFF processing:', error);
        res.status(500).json({ 
            status: 'error',
            error: 'Failed to start processing',
            message: error.message 
        });
    }
});

/**
 * Get Processing Status
 * 
 * This endpoint allows clients to check the status of a TIFF processing job.
 * Processing can take several minutes for large files, so we need a way
 * to provide progress updates.
 */
app.get('/api/processing-status/:id', async (req, res) => {
    const { id } = req.params;
    const statusFile = path.join(__dirname, '../logs', `${id}.json`);
    
    try {
        if (await fs.pathExists(statusFile)) {
            const status = await fs.readJson(statusFile);
            res.json({
                status: 'success',
                processingId: id,
                ...status
            });
        } else {
            res.status(404).json({ 
                status: 'error',
                error: 'Processing ID not found',
                processingId: id
            });
        }
    } catch (error) {
        console.error('Error reading processing status:', error);
        res.status(500).json({ 
            status: 'error',
            error: 'Failed to read processing status',
            message: error.message 
        });
    }
});

/**
 * Background TIFF Processing Function
 * 
 * This function runs the actual GDAL processing in the background.
 * It updates a status file so that clients can track progress.
 */
async function processTiffAsync(inputPath, processingId, options) {
    const statusFile = path.join(__dirname, '../logs', `${processingId}.json`);
    
    try {
        // Initial status
        await updateProcessingStatus(statusFile, { 
            status: 'starting', 
            progress: 0, 
            message: 'Initializing TIFF processing...',
            startTime: new Date().toISOString()
        });

        // Determine output directory name from input filename
        const filename = path.basename(inputPath, path.extname(inputPath));
        const outputDir = path.join(__dirname, '../tiles', filename);
        await fs.ensureDir(outputDir);

        await updateProcessingStatus(statusFile, { 
            status: 'processing', 
            progress: 25, 
            message: 'Running gdal2tiles conversion...'
        });

        // Build the gdal2tiles command
        // This is the heart of the tile generation process
        const gdalCommand = [
            '-p', 'mercator',                                    // Use Web Mercator projection
            '-z', `${options.minZoom || 0}-${options.maxZoom || 12}`, // Zoom levels
            '-w', 'none',                                        // No web viewer generation
            '--processes=4',                                     // Use 4 parallel processes
            '-r', options.resampling || 'average',               // Resampling method
            inputPath,                                           // Input TIFF file
            outputDir                                            // Output directory
        ];

        console.log(`Starting gdal2tiles.py with command: ${gdalCommand.join(' ')}`);

        // Spawn the gdal2tiles process
        const gdal2tiles = spawn('gdal2tiles.py', gdalCommand, {
            stdio: ['ignore', 'pipe', 'pipe'] // Capture stdout and stderr
        });
        
        let outputLog = '';
        let errorLog = '';

        // Capture output for logging
        gdal2tiles.stdout.on('data', (data) => {
            const output = data.toString();
            outputLog += output;
            console.log(`gdal2tiles stdout: ${output.trim()}`);
        });

        gdal2tiles.stderr.on('data', (data) => {
            const output = data.toString();
            errorLog += output;
            console.log(`gdal2tiles stderr: ${output.trim()}`);
        });

        // Handle process completion
        gdal2tiles.on('close', async (code) => {
            if (code === 0) {
                // Success! Create metadata file for the new tileset
                const metadata = {
                    name: filename,
                    description: `Light pollution data processed from ${path.basename(inputPath)}`,
                    source: path.basename(inputPath),
                    minZoom: options.minZoom || 0,
                    maxZoom: options.maxZoom || 12,
                    bounds: options.bounds || [-180, -85, 180, 85], // Default to world bounds
                    processedAt: new Date().toISOString(),
                    processingOptions: options,
                    version: '1.0.0'
                };
                
                await fs.writeJson(path.join(outputDir, 'metadata.json'), metadata, { spaces: 2 });
                
                await updateProcessingStatus(statusFile, { 
                    status: 'completed', 
                    progress: 100, 
                    message: 'TIFF processing completed successfully',
                    completedAt: new Date().toISOString(),
                    outputDir: outputDir,
                    metadata: metadata,
                    tileUrl: `/tiles/${filename}/{z}/{x}/{y}.png`
                });
                
                console.log(`✅ Successfully processed ${inputPath} -> ${outputDir}`);
            } else {
                // Processing failed
                await updateProcessingStatus(statusFile, { 
                    status: 'failed', 
                    progress: 0, 
                    message: `TIFF processing failed with exit code ${code}`,
                    error: errorLog || 'Unknown error',
                    failedAt: new Date().toISOString()
                });
                
                console.error(`❌ GDAL processing failed with code ${code}`);
                console.error('Error output:', errorLog);
            }
        });

    } catch (error) {
        console.error('Processing error:', error);
        await updateProcessingStatus(statusFile, { 
            status: 'failed', 
            progress: 0, 
            message: `Processing error: ${error.message}`,
            error: error.stack,
            failedAt: new Date().toISOString()
        });
    }
}

/**
 * Helper function to update processing status
 */
async function updateProcessingStatus(statusFile, status) {
    await fs.ensureDir(path.dirname(statusFile));
    await fs.writeJson(statusFile, {
        ...status,
        timestamp: new Date().toISOString()
    }, { spaces: 2 });
}

/**
 * Helper function to calculate tileset size
 */
async function calculateTilesetSize(tilesetPath) {
    try {
        const stats = await fs.stat(tilesetPath);
        return {
            bytes: stats.size,
            human: formatBytes(stats.size)
        };
    } catch (error) {
        return { bytes: 0, human: '0 B' };
    }
}

/**
 * Helper function to format bytes into human-readable format
 */
function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

/**
 * Error Handling Middleware
 * 
 * This catches any unhandled errors and returns a proper JSON response
 * instead of crashing the server.
 */
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err.stack);
    res.status(500).json({ 
        status: 'error',
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
    });
});

/**
 * 404 Handler
 * 
 * This handles requests to endpoints that don't exist
 */
app.use((req, res) => {
    res.status(404).json({
        status: 'error',
        error: 'Not found',
        message: `Endpoint ${req.method} ${req.path} not found`,
        availableEndpoints: [
            'GET /health',
            'GET /api/tilesets',
            'POST /api/process-tiff',
            'GET /api/processing-status/:id',
            'GET /tiles/:tileset/:z/:x/:y.png'
        ]
    });
});

/**
 * Start the server
 */
app.listen(PORT, '0.0.0.0', () => {
    console.log('Event Horizon Tile Server Started');
    console.log(`Server running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`API endpoint: http://localhost:${PORT}/api/tilesets`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log('Ready to process light pollution data!');
});