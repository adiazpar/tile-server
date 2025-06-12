/**
 * TIFF Processing Script for Event Horizon
 */

const { spawn } = require('child_process');
const fs = require('fs-extra');
const path = require('path');

class Logger {
    static info(message) {
        console.log(`[INFO] ${message}`);
    }

    static success(message) {
        console.log(`[SUCCESS] ${message}`);
    }

    static warning(message) {
        console.log(`[WARNING] ${message}`);
    }

    static error(message) {
        console.log(`[ERROR] ${message}`);
    }

    static step(stepNumber, totalSteps, message) {
        console.log(`\n[STEP ${stepNumber}/${totalSteps}] ${message}`);
    }

    static section(title) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`  ${title.toUpperCase()}`);
        console.log(`${'='.repeat(60)}`);
    }
}


class TiffProcessor {
    constructor() {
        this.baseDir = path.join(__dirname, '..');
        this.dataDir = path.join(this.baseDir, 'data');
        this.tilesDir = path.join(this.baseDir, 'tiles');
        this.logsDir = path.join(this.baseDir, 'logs');
        
        this.defaultOptions = {
            minZoom: 0,
            maxZoom: 12,
            tileSize: 256,
            profile: 'geodetic',
            resampling: 'average',
            processes: 4,
            webViewer: false
        };
        
        Logger.section('TIFF Processor Initialized');
        Logger.info(`Data directory: ${this.dataDir}`);
        Logger.info(`Tiles directory: ${this.tilesDir}`);
        Logger.info(`Logs directory: ${this.logsDir}`);
    }

    async processTiff(inputFile, options = {}) {
        const config = { ...this.defaultOptions, ...options };
        
        const inputPath = path.resolve(inputFile);
        const filename = path.basename(inputPath, path.extname(inputPath));
        const outputDir = path.join(this.tilesDir, filename);
        
        const intermediateFiles = [];
        const totalSteps = 11;
        let currentStep = 0;

        Logger.step(currentStep, totalSteps, 'Starting TIFF Processing Workflow');
        Logger.info(`Input file: ${inputPath}`);
        Logger.info(`Output directory: ${outputDir}`);
        Logger.info(`Configuration: ${JSON.stringify(config, null, 2)}`);

        try {
            // Step 1: Validate input file
            Logger.step(++currentStep, totalSteps, 'Validating input file');
            await this.validateInputFile(inputPath);
            
            // Step 2: Prepare output directory
            Logger.step(++currentStep, totalSteps, 'Preparing output directory');
            await fs.ensureDir(outputDir);
            await this.cleanOutputDirectory(outputDir);

            // Step 3: Analyze input TIFF
            Logger.step(++currentStep, totalSteps, 'Analyzing input TIFF file');
            const tiffInfo = await this.getTiffInfo(inputPath);
            Logger.info(`File size: ${tiffInfo.size[0]} x ${tiffInfo.size[1]} pixels`);
            Logger.info(`Bands: ${tiffInfo.bands}, Data type: ${tiffInfo.dataType}`);

            // Step 4: Detect projection
            Logger.step(++currentStep, totalSteps, 'Detecting projection and tile profile');
            const profile = await this.detectProjectionProfile(inputPath);
            config.profile = profile;
            Logger.info(`Using tile profile: ${profile}`);

            // Step 5: Handle reprojection if needed
            let processPath = inputPath;
            if (profile === 'geodetic' && config.forceWebMercator) {
                Logger.step(++currentStep, totalSteps, 'Converting to Web Mercator projection');
                processPath = await this.convertToWebMercator(inputPath, filename);
                intermediateFiles.push(processPath);
                config.profile = 'mercator';
            } else {
                currentStep++; // Skip this step
                Logger.info('Skipping reprojection - using existing projection');
            }

            // Step 6: Create optimized version
            Logger.step(++currentStep, totalSteps, 'Creating optimized version');
            const optimizedPath = await this.createOptimizedVRT(processPath, filename);
            if (optimizedPath.endsWith('.vrt') || optimizedPath !== processPath) {
                intermediateFiles.push(optimizedPath);
            }

            // Step 7: Convert to 8-bit with color mapping
            Logger.step(++currentStep, totalSteps, 'Converting to 8-bit with color mapping');
            const colorizedPath = await this.convertTo8BitWithColor(optimizedPath, filename);
            intermediateFiles.push(colorizedPath);

            // Step 8: Generate tiles
            Logger.step(++currentStep, totalSteps, 'Generating tile pyramid');
            await this.generateTiles(colorizedPath, outputDir, config);

            // Step 9: Create metadata
            Logger.step(++currentStep, totalSteps, 'Creating tileset metadata');
            const metadata = await this.createMetadata(inputPath, outputDir, {
                ...config,
                ...tiffInfo
            });

            // Step 10: Cleanup intermediate files
            Logger.step(++currentStep, totalSteps, 'Cleaning up intermediate files');
            await this.cleanupIntermediateFiles(intermediateFiles);

            // Step 11: Verify output
            Logger.step(++currentStep, totalSteps, 'Verifying tile generation');
            const verification = await this.verifyTileset(outputDir);

            return {
                success: true,
                inputFile: inputPath,
                outputDir: outputDir,
                metadata: metadata,
                verification: verification,
                tileUrl: `/tiles/${filename}/{z}/{x}/{y}.png`,
                processingTime: new Date().toISOString()
            };

        } catch (error) {
            Logger.error(`TIFF processing failed: ${error.message}`);
            
            try {
                await this.cleanupIntermediateFiles(intermediateFiles);
                await fs.remove(outputDir);
                Logger.info('Cleanup completed after error');
            } catch (cleanupError) {
                Logger.warning(`Could not clean up: ${cleanupError.message}`);
            }
            
            throw error;
        }
    }
    
    async createOptimizedVRT(inputPath, filename) {
        const vrtPath = path.join(this.dataDir, `${filename}_optimized.vrt`);
        
        Logger.info('Creating optimized VRT...');
        
        return new Promise((resolve, reject) => {
            const args = [
                '-of', 'VRT',
                '-co', 'COMPRESS=LZW',
                inputPath,
                vrtPath
            ];

            const gdal_translate = spawn('gdal_translate', args);
            let error = '';

            gdal_translate.stderr.on('data', (data) => {
                error += data.toString();
            });

            gdal_translate.on('close', (code) => {
                if (code === 0) {
                    Logger.info('VRT created successfully');
                    resolve(vrtPath);
                } else {
                    reject(new Error(`VRT creation failed: ${error}`));
                }
            });
        });
    }
    
    async cleanupIntermediateFiles(files) {
        if (files.length === 0) return;
        
        Logger.info(`Cleaning up ${files.length} intermediate files...`);
        
        for (const file of files) {
            try {
                if (!file.includes('8bit_color')) {
                    await fs.remove(file);
                    Logger.info(`Removed ${path.basename(file)}`);
                } else {
                    Logger.info(`Kept ${path.basename(file)}`);
                }
            } catch (error) {
                Logger.warning(`Could not remove ${file}: ${error.message}`);
            }
        }
        
        Logger.info('Cleanup completed');
    }

    async detectProjectionProfile(inputPath) {
        Logger.info('Detecting projection profile...');
        
        return new Promise((resolve, reject) => {
            const gdalinfo = spawn('gdalinfo', [inputPath]);
            let output = '';

            gdalinfo.stdout.on('data', (data) => {
                output += data.toString();
            });

            gdalinfo.on('close', (code) => {
                if (code === 0) {
                    if (output.includes('EPSG:4326') || output.includes('WGS 84')) {
                        Logger.info('Detected EPSG:4326 (WGS 84)');
                        resolve('geodetic');
                    } else if (output.includes('EPSG:3857') || output.includes('Web Mercator')) {
                        Logger.info('Detected EPSG:3857 (Web Mercator)');
                        resolve('mercator');
                    } else {
                        Logger.info('Unknown projection, defaulting to geodetic');
                        resolve('geodetic');
                    }
                } else {
                    reject(new Error(`Failed to detect projection: ${code}`));
                }
            });
        });
    }

    async convertToWebMercator(inputPath, filename) {
        const outputPath = path.join(this.dataDir, `${filename}_3857.tif`);
        
        Logger.info('Reprojecting to Web Mercator (EPSG:3857)...');
        
        return new Promise((resolve, reject) => {
            const args = [
                '-t_srs', 'EPSG:3857',
                '-r', 'bilinear',
                '-co', 'COMPRESS=LZW',
                '-co', 'TILED=YES',
                inputPath,
                outputPath
            ];

            const gdalwarp = spawn('gdalwarp', args);
            let error = '';

            gdalwarp.stderr.on('data', (data) => {
                error += data.toString();
                // Look for percentage indicators in gdalwarp output
                const percentMatch = data.toString().match(/(\d+)%/);
                if (percentMatch) {
                    const percent = parseInt(percentMatch[1]);
                    Logger.info(`Reprojection progress: ${percent}%`);
                }
            });

            gdalwarp.on('close', (code) => {
                if (code === 0) {
                    Logger.info('Reprojection completed successfully');
                    resolve(outputPath);
                } else {
                    reject(new Error(`Reprojection failed: ${error}`));
                }
            });
        });
    }

    async convertTo8BitWithColor(inputPath, filenameBase) {
        Logger.info('Starting VIIRS-optimized processing with logarithmic scaling');
        
        const stats = await this.analyzeTiffStatisticsAdvanced(inputPath);
        const perc = stats.percentile95;
        
        const tmpLog = path.join(this.dataDir, `${filenameBase}_log.tif`);
        const tmpScaled = path.join(this.dataDir, `${filenameBase}_scaled.tif`);
        const finalColorized = path.join(this.dataDir, `${filenameBase}_8bit_color.tif`);
        
        Logger.info(`Using data range: 0 to ${perc} (95th percentile)`);
        
        // Step 1: Logarithmic transformation
        Logger.info('Applying logarithmic transformation...');
        
        await new Promise((resolve, reject) => {
            const args = [
                '-A', inputPath,
                '--outfile=' + tmpLog,
                '--calc=log10(A + 0.001) - 1',
                '--type=Float32',
                '--co=COMPRESS=LZW',
                '--co=TILED=YES'
            ];
            
            const proc = spawn('gdal_calc.py', args);
            let errLog = '';
            
            proc.stderr.on('data', chunk => {
                errLog += chunk.toString();
                const percentMatch = chunk.toString().match(/(\d+)%/);
                if (percentMatch) {
                    const percent = parseInt(percentMatch[1]);
                    Logger.info(`Log transformation progress: ${percent}%`);
                }
            });
            
            proc.on('close', code => {
                if (code === 0) {
                    Logger.info('Logarithmic transformation completed');
                    resolve();
                } else {
                    reject(new Error(`Log transformation failed: ${errLog}`));
                }
            });
        });
        
        // Step 2: Scale to 0-255
        const logMin = Math.log10(0.001) - 1;
        const logMax = Math.log10(perc + 0.001);

        Logger.info(`Scaling log range ${logMin.toFixed(3)} to ${logMax.toFixed(3)}...`);
        
        await new Promise((resolve, reject) => {
            const args = [
                '-ot', 'Byte',
                '-scale', logMin.toString(), logMax.toString(), '0', '255',
                '-co', 'COMPRESS=LZW',
                '-co', 'TILED=YES',
                tmpLog,
                tmpScaled
            ];
            
            const proc = spawn('gdal_translate', args);
            let errLog = '';
            
            proc.stderr.on('data', chunk => {
                errLog += chunk.toString();
            });
            
            proc.on('close', code => {
                if (code === 0) {
                    Logger.info('Data scaling completed');
                    resolve();
                } else {
                    reject(new Error(`Scaling failed: ${errLog}`));
                }
            });
        });
        
        // Step 3: Apply color mapping
        const colorTable = `# VIIRS Light Pollution Color Table - Logarithmic Optimized
# Designed for values: 0 to ${perc}
# Value R G B Alpha

# 0-170 (covers up to ~95th percentile): blue shades
0 0 0 0 255
50 0 0 10 255
100 0 0 40 255
120 0 80 160 255
150 0 140 255 255

# 170-220 (95th-99th percentile): green/cyan/yellow
170 100 255 180 255
180 180 255 100 255
200 255 255 0 255

# 220-255 (top 1%): red, pink, white
220 255 80 0 255
230 255 0 0 255
240 255 160 255 255
250 255 255 255 255
255 255 255 255 255`;

        const colorTablePath = path.join(this.dataDir, 'viirs_log_optimized.txt');
        await fs.writeFile(colorTablePath, colorTable.trim());
        
        Logger.info('Applying VIIRS-optimized color mapping...');
        
        await new Promise((resolve, reject) => {
            const args = [
                'color-relief',
                tmpScaled,
                colorTablePath,
                finalColorized,
                '-alpha',
                '-co', 'COMPRESS=LZW',
                '-co', 'TILED=YES'
            ];
            
            const proc = spawn('gdaldem', args);
            let errLog = '';
            
            proc.stderr.on('data', chunk => {
                errLog += chunk.toString();
            });
            
            proc.on('close', code => {
                if (code === 0) {
                    Logger.info('Color mapping completed');
                    resolve();
                } else {
                    reject(new Error(`Color mapping failed: ${errLog}`));
                }
            });
        });
        
        // Clean up intermediate files
        await fs.remove(tmpLog);
        await fs.remove(tmpScaled);
        await fs.remove(colorTablePath);
        
        Logger.info('8-bit color conversion completed');
        return finalColorized;
    }
    
    async analyzeTiffStatisticsAdvanced(inputPath) {
        Logger.info('Performing advanced TIFF statistics analysis...');
        
        return new Promise((resolve, reject) => {
            const gdalinfo = spawn('gdalinfo', ['-stats', inputPath]);
            let output = '';
            
            gdalinfo.stdout.on('data', (data) => {
                output += data.toString();
            });
            
            gdalinfo.on('close', (code) => {
                if (code === 0) {
                    const minMatch = output.match(/Minimum=([-\d.]+)/);
                    const maxMatch = output.match(/Maximum=([-\d.]+)/);
                    const meanMatch = output.match(/Mean=([-\d.]+)/);
                    const stdDevMatch = output.match(/StdDev=([-\d.]+)/);
                    
                    const basicStats = {
                        min: minMatch ? parseFloat(minMatch[1]) : 0,
                        max: maxMatch ? parseFloat(maxMatch[1]) : 255,
                        mean: meanMatch ? parseFloat(meanMatch[1]) : 128,
                        stdDev: stdDevMatch ? parseFloat(stdDevMatch[1]) : 50
                    };
                    
                    this.calculatePercentiles(inputPath, basicStats)
                        .then(enhancedStats => {
                            Logger.info(`Min: ${enhancedStats.min}, Max: ${enhancedStats.max}, Mean: ${enhancedStats.mean.toFixed(3)}`);
                            Logger.info('Statistics analysis completed');
                            resolve(enhancedStats);
                        })
                        .catch(reject);
                } else {
                    reject(new Error('Failed to get TIFF statistics'));
                }
            });
        });
    }

    async calculatePercentiles(inputPath, basicStats) {
        const stats = { ...basicStats };
        
        if (stats.max > 100 && stats.mean < 1) {
            // VIIRS light pollution data pattern
            stats.percentile95 = Math.min(stats.max * 0.01, stats.mean + 3 * stats.stdDev);
            stats.percentile98 = Math.min(stats.max * 0.05, stats.mean + 4 * stats.stdDev);
            stats.percentile99 = Math.min(stats.max * 0.1, stats.mean + 5 * stats.stdDev);
            stats.percentile99_9 = Math.min(stats.max * 0.2, stats.mean + 6 * stats.stdDev);
        } else {
            // Standard percentile calculation
            stats.percentile95 = stats.min + (stats.max - stats.min) * 0.95;
            stats.percentile98 = stats.min + (stats.max - stats.min) * 0.98;
            stats.percentile99 = stats.min + (stats.max - stats.min) * 0.99;
            stats.percentile99_9 = stats.min + (stats.max - stats.min) * 0.999;
        }
        
        return stats;
    }

    async validateInputFile(inputPath) {
        Logger.info('Validating input file...');
        
        if (!await fs.pathExists(inputPath)) {
            throw new Error(`Input file does not exist: ${inputPath}`);
        }
        
        const stats = await fs.stat(inputPath);
        const sizeMB = stats.size / (1024 * 1024);
        
        if (sizeMB > 1000) {
            Logger.warning(`Large file detected: ${sizeMB.toFixed(1)}MB - processing may take significant time`);
        }
        
        const ext = path.extname(inputPath).toLowerCase();
        if (!['.tif', '.tiff', '.geotiff'].includes(ext)) {
            Logger.warning(`Unexpected file extension: ${ext} - proceeding anyway`);
        }

        Logger.info(`File validation passed (${sizeMB.toFixed(1)}MB)`);
    }

    async cleanOutputDirectory(outputDir) {
        try {
            if (await fs.pathExists(outputDir)) {
                Logger.info('Cleaning existing output directory');
                await fs.emptyDir(outputDir);
            }
        } catch (error) {
            Logger.warning(`Could not clean output directory: ${error.message}`);
        }
    }

    async getTiffInfo(inputPath) {
        Logger.info('Analyzing TIFF metadata...');
        
        return new Promise((resolve, reject) => {
            const gdalinfo = spawn('gdalinfo', ['-json', inputPath]);
            let output = '';
            let error = '';

            gdalinfo.stdout.on('data', (data) => {
                output += data.toString();
            });

            gdalinfo.stderr.on('data', (data) => {
                error += data.toString();
            });

            gdalinfo.on('close', (code) => {
                if (code === 0) {
                    try {
                        const info = JSON.parse(output);
                        
                        const result = {
                            size: info.size || [0, 0],
                            projection: info.coordinateSystem?.wkt || 'Unknown',
                            bounds: this.extractBounds(info.cornerCoordinates),
                            bands: info.bands?.length || 1,
                            dataType: info.bands?.[0]?.type || 'Unknown',
                            geoTransform: info.geoTransform,
                            metadata: info.metadata
                        };
                        
                        Logger.info('TIFF metadata extraction completed');
                        resolve(result);
                    } catch (parseError) {
                        reject(new Error(`Failed to parse gdalinfo output: ${parseError.message}`));
                    }
                } else {
                    reject(new Error(`gdalinfo failed with code ${code}: ${error}`));
                }
            });
        });
    }

    extractBounds(cornerCoordinates) {
        if (!cornerCoordinates) {
            return [-180, -85, 180, 85];
        }

        try {
            const { lowerLeft, upperRight } = cornerCoordinates;
            return [
                lowerLeft[0],   // west
                lowerLeft[1],   // south
                upperRight[0],  // east
                upperRight[1]   // north
            ];
        } catch (error) {
            Logger.warning('Could not extract bounds from corner coordinates');
            return [-180, -85, 180, 85];
        }
    }

    async generateTiles(inputPath, outputDir, options) {
        Logger.info('Starting tile generation with gdal2tiles...');
        
        const args = [
            '-p', options.profile,
            '-z', `${options.minZoom}-${options.maxZoom}`,
            '-r', options.resampling,
            `--processes=${options.processes}`,
            '-a', '0,0,0,255',
            '--tilesize', options.tileSize.toString(),
            '--xyz',
            '--resume',
        ];

        if (!options.webViewer) {
            args.push('-w', 'none');
        }

        args.push(inputPath, outputDir);

        return new Promise((resolve, reject) => {
            Logger.info(`Command: gdal2tiles.py ${args.join(' ')}`);
            
            const gdal2tiles = spawn('gdal2tiles.py', args);
            
            let lastOutput = '';
            let outputBuffer = '';

            gdal2tiles.stdout.on('data', (data) => {
                outputBuffer += data.toString();
                const lines = outputBuffer.split('\n');
                outputBuffer = lines.pop();
                
                for (const line of lines) {
                    const output = line.trim();
                    if (output && output !== lastOutput) {
                        // Parse gdal2tiles output for progress information
                        if (output.includes('Building zoom')) {
                            const zoomMatch = output.match(/Building zoom (\d+)/);
                            if (zoomMatch) {
                                const currentZoom = parseInt(zoomMatch[1]);
                                Logger.info(`Building zoom level ${currentZoom}`);
                            }
                        } else if (output.includes('Generating tiles')) {
                            const tileMatch = output.match(/(\d+)\/(\d+)/);
                            if (tileMatch) {
                                const current = parseInt(tileMatch[1]);
                                const total = parseInt(tileMatch[2]);
                                Logger.info(`Generating tiles: ${current}/${total}`);
                            }
                        } else if (output.includes('%')) {
                            const percentMatch = output.match(/(\d+)%/);
                            if (percentMatch) {
                                const percent = parseInt(percentMatch[1]);
                                Logger.info(`Tile generation progress: ${percent}%`);
                            }
                        }
                        
                        lastOutput = output;
                    }
                }
            });

            gdal2tiles.stderr.on('data', (data) => {
                const output = data.toString().trim();
                if (output && !output.includes('Warning') && !output.includes('GDAL_DATA')) {
                    Logger.warning(`gdal2tiles: ${output}`);
                }
            });

            gdal2tiles.on('close', (code) => {
                if (code === 0) {
                    Logger.info('Tile generation completed successfully');
                    resolve();
                } else {
                    reject(new Error(`Tile generation failed with exit code: ${code}`));
                }
            });
        });
    }

    async createMetadata(inputPath, outputDir, options) {
        const metadata = {
            name: path.basename(inputPath, path.extname(inputPath)),
            description: `Light pollution tileset generated from ${path.basename(inputPath)}`,
            source: {
                filename: path.basename(inputPath),
                path: inputPath,
                size: (await fs.stat(inputPath)).size
            },
            tiles: {
                minZoom: options.minZoom,
                maxZoom: options.maxZoom,
                tileSize: options.tileSize,
                profile: options.profile,
                resampling: options.resampling
            },
            geographic: {
                bounds: options.bounds,
                projection: options.projection,
                size: options.size
            },
            processing: {
                processedAt: new Date().toISOString(),
                version: '1.0.0',
                processor: 'Event Horizon Tile Server',
                gdal: await this.getGDALVersion()
            }
        };

        const metadataPath = path.join(outputDir, 'metadata.json');
        await fs.writeJson(metadataPath, metadata, { spaces: 2 });

        Logger.info(`Metadata saved to: ${metadataPath}`);
        return metadata;
    }

    async getGDALVersion() {
        return new Promise((resolve) => {
            const gdalinfo = spawn('gdalinfo', ['--version']);
            let version = 'unknown';

            gdalinfo.stdout.on('data', (data) => {
                version = data.toString().trim();
            });

            gdalinfo.on('close', () => {
                resolve(version);
            });
        });
    }

    async verifyTileset(outputDir) {
        Logger.info('Verifying tileset generation...');
        
        const verification = {
            outputExists: await fs.pathExists(outputDir),
            metadataExists: await fs.pathExists(path.join(outputDir, 'metadata.json')),
            tileCount: 0,
            zoomLevels: []
        };

        Logger.info('Checking output directory...');

        if (verification.outputExists) {
            try {
                Logger.info('Scanning zoom levels...');
                
                const contents = await fs.readdir(outputDir);
                verification.zoomLevels = contents.filter(item => 
                    /^\d+$/.test(item) && fs.statSync(path.join(outputDir, item)).isDirectory()
                ).map(Number).sort((a, b) => a - b);

                Logger.info(`Found ${verification.zoomLevels.length} zoom levels: ${verification.zoomLevels.join(', ')}`);
                Logger.info('Counting tiles...');
                
                for (const zoom of verification.zoomLevels) {
                    const zoomDir = path.join(outputDir, zoom.toString());
                    const xDirs = await fs.readdir(zoomDir);
                    let zoomTileCount = 0;
                    
                    for (const xDir of xDirs) {
                        const yDir = path.join(zoomDir, xDir);
                        if ((await fs.stat(yDir)).isDirectory()) {
                            const tiles = await fs.readdir(yDir);
                            const tileCount = tiles.filter(tile => tile.endsWith('.png')).length;
                            zoomTileCount += tileCount;
                        }
                    }
                    
                    verification.tileCount += zoomTileCount;
                    Logger.info(`Zoom level ${zoom}: ${zoomTileCount} tiles`);
                }
                
                Logger.info('Verification completed');
            } catch (error) {
                Logger.warning(`Could not verify tile structure: ${error.message}`);
            }
        } else {
            Logger.warning('Output directory not found');
        }

        Logger.info(`Verification results: ${verification.tileCount} tiles in ${verification.zoomLevels.length} zoom levels`);
        return verification;
    }
}

// Command Line Interface
if (require.main === module) {
    const args = process.argv.slice(2);
    
    if (args.length < 1) {
        Logger.section('Event Horizon TIFF Processor');
        console.log('');
        console.log('Usage: node process-tiff.js <input-file> [options]');
        console.log('');
        console.log('Options:');
        console.log('  --min-zoom <number>      Minimum zoom level (default: 0)');
        console.log('  --max-zoom <number>      Maximum zoom level (default: 12)');
        console.log('  --tile-size <number>     Tile size in pixels (default: 256)');
        console.log('  --profile <string>       Tile profile (default: auto-detect)');
        console.log('  --resampling <string>    Resampling method (default: average)');
        console.log('  --processes <number>     Number of processes (default: 4)');
        console.log('  --force-web-mercator     Force conversion to Web Mercator');
        console.log('  --web-viewer            Generate web viewer');
        console.log('');
        console.log('Examples:');
        console.log('  node process-tiff.js data/light-pollution.tif');
        console.log('  node process-tiff.js data/viirs-2023.tif --max-zoom 10 --processes 8');
        console.log('');
        process.exit(1);
    }

    const inputFile = args[0];
    const options = {};

    for (let i = 1; i < args.length; i += 2) {
        const option = args[i];
        const value = args[i + 1];

        switch (option) {
            case '--min-zoom':
                options.minZoom = parseInt(value);
                break;
            case '--max-zoom':
                options.maxZoom = parseInt(value);
                break;
            case '--tile-size':
                options.tileSize = parseInt(value);
                break;
            case '--profile':
                options.profile = value;
                break;
            case '--resampling':
                options.resampling = value;
                break;
            case '--processes':
                options.processes = parseInt(value);
                break;
            case '--force-web-mercator':
                options.forceWebMercator = true;
                i--;
                break;
            case '--web-viewer':
                options.webViewer = true;
                i--;
                break;
            default:
                Logger.warning(`Unknown option: ${option}`);
                break;
        }
    }

    const processor = new TiffProcessor();
    processor.processTiff(inputFile, options)
        .then(result => {
            Logger.section('Processing Summary');
            Logger.success('Processing completed successfully!');
            Logger.info(`Output directory: ${result.outputDir}`);
            Logger.info(`Tile URL template: ${result.tileUrl}`);
            Logger.info(`Tiles generated: ${result.verification.tileCount}`);
            Logger.info(`Zoom levels: ${result.verification.zoomLevels.join(', ')}`);
            console.log('');
        })
        .catch(error => {
            Logger.section('Processing Failed');
            Logger.error(`Processing failed: ${error.message}`);
            console.log('');
            if (process.env.NODE_ENV === 'development') {
                console.error('Stack trace:', error.stack);
            }
            process.exit(1);
        });
}

module.exports = TiffProcessor;