#!/bin/bash
# Startup script for local.assembly.fm on macOS — convenience wrapper that sets
# MODE and does the macOS-only bits (sudo, static IP, dnsmasq) for performance.
# server.ts is mode-driven and runs standalone on any OS: `MODE=… deno run …`.
# Usage:
#   ./start-macos.sh practice     Solo, laptop only — localhost:8443, no sudo/cert/dnsmasq (default)
#   ./start-macos.sh workshop     Phones on a LAN — 0.0.0.0:8443, self-signed cert, no sudo
#   ./start-macos.sh performance  Public show — ports 80+443, captive portal, dnsmasq, sudo
#   ./start-macos.sh dns          Start dnsmasq DNS server only
#   ./start-macos.sh status       Show system status
#   (append --watch to any mode for auto-reload)

set -e

# Fixed config
SUBNET="192.168.178"
STATIC_IP="192.168.178.24"  # must match FritzBox DNS server setting
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DNSMASQ_BIN="/opt/homebrew/opt/dnsmasq/sbin/dnsmasq"
DNSMASQ_CONF="/opt/homebrew/etc/dnsmasq.d/assembly.conf"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

echo_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

echo_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# --- Auto-detect network interface and IP on the assembly subnet ---

detect_network() {
    local found_if=""
    local found_ip=""

    # scan all interfaces for one with an IP on the assembly subnet
    while IFS= read -r line; do
        if [[ "$line" =~ ^([a-z0-9]+): ]]; then
            current_if="${BASH_REMATCH[1]}"
        fi
        if [[ "$line" =~ inet\ ($SUBNET\.[0-9]+) ]]; then
            found_if="$current_if"
            found_ip="${BASH_REMATCH[1]}"
            break
        fi
    done < <(ifconfig)

    if [ -z "$found_if" ]; then
        echo_error "No interface found on $SUBNET.x subnet"
        echo_error "Is the ethernet cable connected to the network hardware?"
        echo ""
        echo "Available interfaces with IPs:"
        ifconfig | grep -E "^[a-z]|inet " | grep -B1 "inet " | grep -v "^--$"
        exit 1
    fi

    ETHERNET_IF="$found_if"

    # ensure the interface has the static IP the FritzBox expects
    if [ "$found_ip" != "$STATIC_IP" ]; then
        echo_warn "Interface $ETHERNET_IF has IP $found_ip, FritzBox expects $STATIC_IP"
        echo_info "Setting static IP $STATIC_IP on $ETHERNET_IF..."
        sudo ifconfig "$ETHERNET_IF" "$STATIC_IP" netmask 255.255.255.0
        # re-add the gateway so we stay routable on the subnet
        sudo route -n add -net "$SUBNET.0/24" "$STATIC_IP" 2>/dev/null || true
        echo_info "IP set to $STATIC_IP"
    fi

    MAC_IP="$STATIC_IP"
    echo_info "Detected interface: $ETHERNET_IF ($MAC_IP)"
}

# --- Kill stale dnsmasq if running on wrong interface/IP ---

DNSMASQ_ALREADY_OK=false

ensure_clean_dnsmasq() {
    if pgrep -f "dnsmasq" > /dev/null 2>&1; then
        # check if current config matches what we need
        local needs_restart=false

        if [ -f "$DNSMASQ_CONF" ]; then
            local conf_if=$(grep "^interface=" "$DNSMASQ_CONF" 2>/dev/null | cut -d= -f2)
            local conf_ip=$(grep "^address=" "$DNSMASQ_CONF" 2>/dev/null | sed 's|address=/\#/||')
            if [ "$conf_if" != "$ETHERNET_IF" ] || [ "$conf_ip" != "$MAC_IP" ]; then
                needs_restart=true
                echo_warn "Stale dnsmasq running (interface=$conf_if, ip=$conf_ip)"
            fi
        else
            needs_restart=true
        fi

        if [ "$needs_restart" = true ]; then
            echo_info "Killing stale dnsmasq..."
            sudo pkill -f dnsmasq || true
            sleep 1
        else
            echo_info "dnsmasq already running with correct config"
            DNSMASQ_ALREADY_OK=true
        fi
    fi
}

# --- Write dnsmasq config if needed ---

ensure_dnsmasq_conf() {
    local needs_update=false

    if [ ! -f "$DNSMASQ_CONF" ]; then
        needs_update=true
    else
        local conf_if=$(grep "^interface=" "$DNSMASQ_CONF" 2>/dev/null | cut -d= -f2)
        local conf_ip=$(grep "^address=" "$DNSMASQ_CONF" 2>/dev/null | sed 's|address=/\#/||')
        if [ "$conf_if" != "$ETHERNET_IF" ] || [ "$conf_ip" != "$MAC_IP" ]; then
            needs_update=true
            echo_warn "dnsmasq config out of date (was $conf_if/$conf_ip, now $ETHERNET_IF/$MAC_IP)"
        fi
    fi

    if [ "$needs_update" = true ]; then
        echo_info "Writing dnsmasq config..."
        sudo mkdir -p "$(dirname "$DNSMASQ_CONF")"
        echo "interface=$ETHERNET_IF
address=/#/$MAC_IP" | sudo tee "$DNSMASQ_CONF" > /dev/null
        echo_info "Updated $DNSMASQ_CONF"
    fi
}

check_deno() {
    if ! command -v deno &> /dev/null; then
        echo_error "deno not found. Install from https://deno.land/"
        exit 1
    fi
}

# performance requires a real Let's Encrypt cert (server.ts also fails loud, but
# we check here too so the error arrives before sudo prompts).
check_cert() {
    if [ ! -f "$PROJECT_DIR/cert.pem" ] || [ ! -f "$PROJECT_DIR/key.pem" ]; then
        echo_error "performance mode needs a real TLS cert (cert.pem + key.pem)."
        echo_error "Use './start-macos.sh workshop' for an auto-generated self-signed cert,"
        echo_error "or obtain a Let's Encrypt cert for local.assembly.fm."
        exit 1
    fi
}

check_dnsmasq() {
    if [ ! -f "$DNSMASQ_BIN" ]; then
        echo_error "dnsmasq not found. Install with: brew install dnsmasq"
        exit 1
    fi
}

start_dns() {
    detect_network
    ensure_clean_dnsmasq
    ensure_dnsmasq_conf

    echo_info "Starting dnsmasq DNS server..."
    echo_info "Interface: $ETHERNET_IF → resolving all DNS to $MAC_IP"
    echo_info "Press Ctrl+C to stop"
    echo ""

    sudo "$DNSMASQ_BIN" \
        --keep-in-foreground \
        --bind-interfaces \
        --conf-file="$DNSMASQ_CONF"
}

# Launch the Deno server. $1 = MODE; $2 = "sudo" to elevate (performance only).
# $WATCH (set from --watch) appends --watch=... ; empty otherwise.
run_deno() {
    local mode="$1"
    local elevate="$2"
    cd "$PROJECT_DIR"
    if [ "$elevate" = "sudo" ]; then
        # `sudo VAR=val cmd` passes the env var through to the elevated process.
        sudo MODE="$mode" "$(which deno)" run -A --unstable-net $WATCH server.ts
    else
        MODE="$mode" "$(which deno)" run -A --unstable-net $WATCH server.ts
    fi
}

show_status() {
    detect_network

    echo_info "=== local.assembly.fm Status ==="
    echo ""

    # Check dnsmasq
    if pgrep -f "dnsmasq.*assembly.conf" > /dev/null; then
        echo_info "✓ dnsmasq is running"
    else
        echo_warn "✗ dnsmasq is NOT running"
        echo "  Start with: ./start-macos.sh dns"
    fi

    # Check Deno server
    if sudo lsof -i :443 | grep -q LISTEN; then
        echo_info "✓ Deno server is running on port 443"
    else
        echo_warn "✗ Deno server is NOT running"
        echo "  Start with: ./start-macos.sh performance"
    fi

    # Check network
    echo ""
    echo_info "=== Network Status ==="
    echo "Interface: $ETHERNET_IF"
    echo "IP: $MAC_IP"

    # Check APs
    echo ""
    echo_info "=== Access Points ==="
    if ping -c 1 -W 1 192.168.178.20 &>/dev/null; then
        echo_info "✓ AP #1 (192.168.178.20) is reachable"
    else
        echo_warn "✗ AP #1 (192.168.178.20) is NOT reachable"
    fi

    if ping -c 1 -W 1 192.168.178.21 &>/dev/null; then
        echo_info "✓ AP #2 (192.168.178.21) is reachable"
    else
        echo_warn "✗ AP #2 (192.168.178.21) is NOT reachable"
    fi

    echo ""
    echo_info "=== Quick Test ==="
    echo "On your phone:"
    echo "  1. Connect to WiFi 'assembly' (password: assembly)"
    echo "  2. Captive portal should auto-appear"
    echo "  3. Or visit any URL (e.g., example.com) to trigger redirect"
}

# --- Parse args: first non-flag token is the mode; --watch is orthogonal ---
WATCH_FILES="server.ts,eval-engine.ts,hardware.ts,patch-state.ts,public/gpi-types.js,public/graph-core.js"
MODE_ARG=""
WATCH=""
for arg in "$@"; do
    case "$arg" in
        --watch) WATCH="--watch=$WATCH_FILES" ;;
        *) if [ -z "$MODE_ARG" ]; then MODE_ARG="$arg"; fi ;;
    esac
done

# Main
case "$MODE_ARG" in
    practice|"")
        check_deno
        echo_info "practice mode — http://localhost:8443/ (no sudo, no cert, no dnsmasq)"
        echo_info "Ctrl+C to stop"
        echo ""
        run_deno practice
        ;;
    workshop)
        check_deno
        if ! command -v openssl &> /dev/null; then
            echo_error "workshop mode needs openssl to generate a self-signed cert."
            exit 1
        fi
        echo_info "workshop mode — https://<lan-ip>:8443/ (self-signed, no sudo)"
        echo_info "Phones open the URL and tap through the certificate warning."
        echo_info "Ctrl+C to stop"
        echo ""
        run_deno workshop
        ;;
    performance)
        check_deno
        check_cert
        check_dnsmasq
        detect_network
        ensure_clean_dnsmasq
        ensure_dnsmasq_conf

        if [ "$DNSMASQ_ALREADY_OK" = false ]; then
            echo_info "Starting dnsmasq in background..."
            sudo "$DNSMASQ_BIN" \
                --bind-interfaces \
                --conf-file="$DNSMASQ_CONF"
            echo_info "dnsmasq running (interface=$ETHERNET_IF → $MAC_IP)"
        fi

        echo_info "performance mode — https://local.assembly.fm/ (captive portal, ports 80+443)"
        echo_info "Ctrl+C to stop (will also kill dnsmasq)"
        echo ""

        # kill dnsmasq when the server exits
        trap 'sudo pkill -f "dnsmasq.*assembly.conf" 2>/dev/null; echo ""; echo_info "Stopped."' EXIT

        run_deno performance sudo
        ;;
    dns)
        check_deno
        check_dnsmasq
        start_dns
        ;;
    status)
        show_status
        ;;
    *)
        echo_error "Unknown mode: $MODE_ARG"
        echo "Usage: ./start-macos.sh [practice|workshop|performance|dns|status] [--watch]"
        exit 1
        ;;
esac
