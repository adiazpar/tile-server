# Dockerfile for Event Horizon Tile Server with reliable GDAL+PNG support
FROM ubuntu:22.04

# Prevent interactive prompts during installation
ENV DEBIAN_FRONTEND=noninteractive

# Set metadata
LABEL maintainer="Event Horizon Team"
LABEL description="Custom tile server for light pollution data processing"
LABEL version="1.0.0"

RUN echo "Acquire::http::Pipeline-Depth 0;" > /etc/apt/apt.conf.d/99custom && \
    echo "Acquire::http::No-Cache true;" >> /etc/apt/apt.conf.d/99custom && \
    echo "Acquire::BrokenProxy    true;" >> /etc/apt/apt.conf.d/99custom

# Install Node.js 18, GDAL, and all necessary dependencies
RUN apt-get clean && apt-get update && apt-get upgrade -y && apt-get install -y \
    curl \
    gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
    && apt-get install -y \
    nodejs \
    gdal-bin \
    python3-gdal \
    python3-pip \
    python3-dev \
    libgdal-dev \
    libpng16-16 \
    libpng-dev \
    libjpeg8 \
    libjpeg8-dev \
    libtiff5 \
    libtiff5-dev \
    libgeotiff5 \
    libgeotiff-dev \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Verify GDAL has PNG support
RUN echo "Checking GDAL drivers:" && gdalinfo --formats | grep -E "(PNG|JPEG)" || echo "Some drivers may be missing"
RUN echo "GDAL version:" && gdalinfo --version

# Create non-root user for security BEFORE setting workdir
RUN groupadd -r nodejs && useradd -r -g nodejs -u 1001 -m nextjs

# Set working directory
WORKDIR /app

# Copy package files and install Node.js dependencies AS ROOT
COPY package*.json ./
RUN npm install && npm cache clean --force

# Install nodemon globally for development hot-reloading
RUN npm install -g nodemon

# Create directory structure
RUN mkdir -p data tiles logs config

# Create npm cache directory and set permissions
RUN mkdir -p /app/.npm-cache && \
    chown -R nextjs:nodejs /app/.npm-cache

# Copy application source code
COPY . .

# Change ownership of entire app directory
RUN chown -R nextjs:nodejs /app

# Configure npm for the nextjs user
RUN su nextjs -c "npm config set cache /app/.npm-cache"

# Switch to non-root user
USER nextjs

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3001/health || exit 1

# Default command
CMD ["npm", "start"]