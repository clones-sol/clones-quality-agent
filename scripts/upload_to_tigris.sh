#!/bin/bash

set -euo pipefail

echo "🚀 Uploading Clones Quality Agent binaries to Tigris"

# Configuration
export TIGRIS_BUCKET="clones-desktop-release-prod"
export BUCKET_URL="https://releases.clones-ai.com"
export TIGRIS_ENDPOINT="https://fly.storage.tigris.dev"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

log_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

log_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

log_error() {
    echo -e "${RED}❌ $1${NC}"
}

# Get app version from package.json
get_app_version() {
    if [ ! -f "package.json" ]; then
        log_error "package.json not found"
        exit 1
    fi
    
    local version=$(jq -r .version package.json)
    
    if [ -z "$version" ] || [ "$version" = "null" ]; then
        log_error "Could not extract version from package.json"
        exit 1
    fi
    
    echo "$version"
}

# Upload file to Tigris
upload_file() {
    local file_path="$1"
    local s3_key="$2"
    local version="$3"
    local platform="$4"
    
    if [ ! -f "$file_path" ]; then
        log_error "File not found: $file_path"
        return 1
    fi
    
    local file_size=$(stat -f%z "$file_path" 2>/dev/null || stat -c%s "$file_path")
    local file_name=$(basename "$file_path")
    local upload_date=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    
    log_info "Uploading $file_name (${file_size} bytes) to $s3_key..."
    
    # Upload to S3-compatible Tigris storage with metadata
    aws s3 cp "$file_path" \
        "s3://${TIGRIS_BUCKET}/${s3_key}" \
        --endpoint-url "$TIGRIS_ENDPOINT" \
        --region auto \
        --metadata "version=$version,platform=$platform,uploaded=$upload_date" \
        --content-type "application/octet-stream" \
        --no-progress
    
    log_success "Uploaded: $file_name → $s3_key"
    echo "  📄 Direct URL: ${BUCKET_URL}/${s3_key}"
}


# Upload all binaries
upload_binaries() {
    local version="$1"
    local target_dir="target"
    
    if [ ! -d "$target_dir" ]; then
        log_error "Target directory not found: $target_dir"
        log_info "Run 'bun run build' first"
        exit 1
    fi
    
    log_info "Uploading binaries from: $target_dir"
    
    # Upload packaged binaries first (with dependencies)
    local packaged_dir="$target_dir/packaged"
    if [ -d "$packaged_dir" ]; then
        for package_file in "$packaged_dir"/*.{tar.gz,zip}; do
            if [ -f "$package_file" ]; then
                local file_name=$(basename "$package_file")
                local platform="unknown"
                if [[ "$file_name" =~ linux ]]; then
                    platform="linux"
                elif [[ "$file_name" =~ macos ]]; then
                    platform="macos"
                elif [[ "$file_name" =~ win ]]; then
                    platform="windows"
                fi
                
                upload_file "$package_file" "cqa/$file_name" "$version" "$platform"
            fi
        done
    fi
    
    # Upload each binary file directly from target directory
    for binary_file in "$target_dir"/*; do
        if [ -f "$binary_file" ] && [[ ! "$binary_file" =~ \.(json|md|txt)$ ]]; then
            local file_name=$(basename "$binary_file")
            
            # Determine platform from filename
            local platform="unknown"
            if [[ "$file_name" =~ linux ]]; then
                platform="linux"
            elif [[ "$file_name" =~ macos ]]; then
                platform="macos"
            elif [[ "$file_name" =~ win ]]; then
                platform="windows"
            fi
            
            # Add version to filename
            local base_name="${file_name%.*}"
            local extension="${file_name##*.}"
            local versioned_name
            
            if [[ "$file_name" == *.* ]]; then
                versioned_name="${base_name}-v${version}.${extension}"
            else
                versioned_name="${base_name}-v${version}"
            fi
            
            log_info "Processing file: $file_name -> $versioned_name (platform: $platform)"
            
            # Upload to cqa folder with versioned name
            upload_file "$binary_file" "cqa/$versioned_name" "$version" "$platform"
        fi
    done
    
}

# Check prerequisites
check_prerequisites() {
    # Check AWS CLI
    if ! command -v aws &> /dev/null; then
        log_error "AWS CLI not found. Please install it."
        exit 1
    fi
    
    # Check jq
    if ! command -v jq &> /dev/null; then
        log_error "jq not found. Please install it."
        exit 1
    fi
    
    # Check Tigris credentials
    if [ -z "${TIGRIS_ACCESS_KEY_ID:-}" ]; then
        log_error "TIGRIS_ACCESS_KEY_ID not set"
        log_info "Set it as environment variable or in .env file"
        exit 1
    fi
    
    if [ -z "${TIGRIS_SECRET_ACCESS_KEY:-}" ]; then
        log_error "TIGRIS_SECRET_ACCESS_KEY not set" 
        log_info "Set it as environment variable or in .env file"
        exit 1
    fi
    
    # Configure AWS environment for Tigris
    export AWS_ACCESS_KEY_ID="$TIGRIS_ACCESS_KEY_ID"
    export AWS_SECRET_ACCESS_KEY="$TIGRIS_SECRET_ACCESS_KEY"
    export AWS_ENDPOINT_URL="$TIGRIS_ENDPOINT"
    export AWS_REGION="auto"
}

# Load environment variables from .env file if it exists
load_env() {
    if [ -f ".env" ]; then
        log_info "Loading environment variables from .env..."
        export $(grep -v '^#' .env | xargs)
        log_success "Environment variables loaded"
    fi
}

# Main execution
main() {
    echo "🔗 Clones Quality Agent - Tigris Upload Script"
    echo "=============================================="
    
    load_env
    check_prerequisites
    
    local version=$(get_app_version)
    log_info "App version: $version"
    
    upload_binaries "$version"
    
    echo ""
    log_success "🎉 Upload completed successfully!"
    log_info "Files available at:"
    echo "  📦 Builds: ${BUCKET_URL}/cqa/"
}

# Run if executed directly
if [ "${BASH_SOURCE[0]}" == "${0}" ]; then
    main "$@"
fi