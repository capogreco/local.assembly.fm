#!/bin/bash
# Startup script for local.assembly.fm on macOS — convenience wrapper that sets
# MODE and does the macOS-only bits (sudo, static IP, dnsmasq) for performance.
# server.ts is mode-driven and runs standalone on any OS: `MODE=… deno run …`.
# Usage:
#   ./start-macos.sh practice     Solo, laptop only — localhost:8443, no sudo/cert/dnsmasq (default)
#   ./start-macos.sh workshop     Phones on a LAN — 0.0.0.0:8443, self-signed cert, no sudo
#   ./start-macos.sh performance  Public show — ports 80+443, captive portal, dnsmasq, sudo
#   ./start-macos.sh renew        Renew the Let's Encrypt cert (DNS-01, interactive)
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

# Cert resolution — mirrors server.ts. Prefer certbot's live paths so renewal is
# zero-copy; fall back to a hand-copied pair in the repo root.
HOST_DOMAIN="${HOST_DOMAIN:-local.assembly.fm}"
LE_CERT="/etc/letsencrypt/live/$HOST_DOMAIN/fullchain.pem"
LE_KEY="/etc/letsencrypt/live/$HOST_DOMAIN/privkey.pem"
REPO_CERT="$PROJECT_DIR/cert.pem"
REPO_KEY="$PROJECT_DIR/key.pem"

# Sets CERT_PATH / KEY_PATH to the first readable pair, or empty on miss.
# Uses sudo -n so we can stat root-owned letsencrypt files without prompting
# (performance-mode call sites cache credentials via `sudo -v` before this).
resolve_cert_path() {
    if sudo -n test -r "$LE_CERT" 2>/dev/null && sudo -n test -r "$LE_KEY" 2>/dev/null; then
        CERT_PATH="$LE_CERT"; KEY_PATH="$LE_KEY"
    elif [ -r "$REPO_CERT" ] && [ -r "$REPO_KEY" ]; then
        CERT_PATH="$REPO_CERT"; KEY_PATH="$REPO_KEY"
    else
        CERT_PATH=""; KEY_PATH=""
    fi
}

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

    # scan all interfaces for one with an IP on the assembly subnet
    while IFS= read -r line; do
        if [[ "$line" =~ ^([a-z0-9]+): ]]; then
            current_if="${BASH_REMATCH[1]}"
        fi
        if [[ "$line" =~ inet\ ($SUBNET\.[0-9]+) ]]; then
            found_if="$current_if"
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

    # Remove any subnet IPs on the interface that aren't STATIC_IP (DHCP-
    # assigned aliases, leftovers from a previous run). Leaving them behind
    # keeps their /32 lo0 route around and can block macOS from installing
    # one for STATIC_IP.
    for ip in $(ifconfig "$ETHERNET_IF" | awk '/inet /{print $2}' | grep "^$SUBNET\." || true); do
        if [ "$ip" != "$STATIC_IP" ]; then
            echo_info "Removing stale IP $ip from $ETHERNET_IF"
            sudo ifconfig "$ETHERNET_IF" -alias "$ip" 2>/dev/null || true
        fi
    done

    # Ensure STATIC_IP is present AND has the /32 lo0 route macOS uses for
    # source-address selection. That route is normally installed automatically
    # when the address is added — but `ifconfig <if> <ip>` used as a replace-
    # in-place can skip it, leaving `connect(STATIC_IP)` from this host failing
    # with EADDRNOTAVAIL. Detect the miss and force a clean -alias/inet cycle.
    if ! netstat -rn -f inet | grep -qE "^$STATIC_IP[[:space:]].*lo0"; then
        echo_info "Assigning $STATIC_IP to $ETHERNET_IF"
        sudo ifconfig "$ETHERNET_IF" -alias "$STATIC_IP" 2>/dev/null || true
        sudo ifconfig "$ETHERNET_IF" inet "$STATIC_IP" netmask 255.255.255.0
        sudo route -n add -net "$SUBNET.0/24" "$STATIC_IP" >/dev/null 2>&1 || true
    fi

    # Sweep any stale lo0-scoped host routes for other subnet IPs (leftovers
    # from prior DHCP leases). Keeps the routing table tidy.
    while read -r stale; do
        [ -z "$stale" ] && continue
        [ "$stale" = "$STATIC_IP" ] && continue
        echo_info "Cleaning stale lo0 route for $stale"
        sudo route delete -host "$stale" >/dev/null 2>&1 || true
    done < <(netstat -rn -f inet | awk -v s="$SUBNET" '$1 ~ "^"s"\\." && $NF == "lo0" {print $1}')

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
    resolve_cert_path
    if [ -z "$CERT_PATH" ]; then
        echo_error "performance mode needs a real TLS cert."
        echo_error "  Looked for (in order):"
        echo_error "    $LE_CERT"
        echo_error "    $REPO_CERT (repo-root fallback)"
        echo_error "  Get one with: ./start-macos.sh renew"
        echo_error "  Or use './start-macos.sh workshop' for an auto-generated self-signed cert."
        exit 1
    fi

    # openssl -checkend needs a readable file; root-owned letsencrypt files
    # require sudo (already cached by the performance branch's `sudo -v`).
    local pfx=""; [ -r "$CERT_PATH" ] || pfx="sudo -n"

    # rustls will happily serve an expired cert; browsers won't. Fail before startup.
    if ! $pfx openssl x509 -checkend 0 -noout -in "$CERT_PATH" > /dev/null 2>&1; then
        local expiry=$($pfx openssl x509 -enddate -noout -in "$CERT_PATH" | cut -d= -f2)
        echo_error "$CERT_PATH is expired (notAfter: $expiry)."
        echo_error "Every browser will reject the connection. Renew with: ./start-macos.sh renew"
        exit 1
    fi

    # Warn well before load-in — DNS-01 renewal needs internet + registrar access.
    if ! $pfx openssl x509 -checkend $((7*86400)) -noout -in "$CERT_PATH" > /dev/null 2>&1; then
        local expiry=$($pfx openssl x509 -enddate -noout -in "$CERT_PATH" | cut -d= -f2)
        echo_warn "$CERT_PATH expires within 7 days (notAfter: $expiry). Renew soon."
    fi
    echo_info "cert:  $CERT_PATH"
}

check_dnsmasq() {
    if [ ! -f "$DNSMASQ_BIN" ]; then
        echo_error "dnsmasq not found. Install with: brew install dnsmasq"
        exit 1
    fi
}

renew_cert() {
    if ! command -v certbot &> /dev/null; then
        echo_error "certbot not found. Install with: brew install certbot"
        exit 1
    fi

    echo_info "Renewing Let's Encrypt cert for $HOST_DOMAIN via DNS-01."
    echo_info "You will be prompted to add a TXT record at your DNS registrar."
    echo_info "  Host:  _acme-challenge.$(echo "$HOST_DOMAIN" | cut -d. -f1)"
    echo_info "  (i.e. leave off the trailing '.$(echo "$HOST_DOMAIN" | cut -d. -f2-)' — most registrars append it)"
    echo ""

    sudo certbot certonly --manual --preferred-challenges dns -d "$HOST_DOMAIN"

    # Confirm the new cert with its notAfter — server + start-macos.sh now read
    # /etc/letsencrypt/live directly, so no copy step is needed.
    if [ -r "$LE_CERT" ] || sudo -n test -r "$LE_CERT" 2>/dev/null; then
        local pfx=""; [ -r "$LE_CERT" ] || pfx="sudo -n"
        local expiry=$($pfx openssl x509 -enddate -noout -in "$LE_CERT" | cut -d= -f2)
        echo ""
        echo_info "✓ cert at $LE_CERT (notAfter: $expiry)"
        echo_info "Ready. Start the show with: ./start-macos.sh performance"
    else
        echo_error "Cert not found at $LE_CERT after renewal — check certbot output above."
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
        echo_info "workshop mode — https://<lan-ip>:8443/ (self-signed, no sudo)"
        echo_info "Phones open the URL and tap through the certificate warning."
        echo_info "Ctrl+C to stop"
        echo ""
        run_deno workshop
        ;;
    performance)
        check_deno
        # Front-load sudo so check_cert can probe root-owned letsencrypt paths
        # non-interactively. Performance mode always needs sudo (ports 80/443,
        # dnsmasq); this just moves the prompt earlier in the pipeline.
        sudo -v
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
    renew)
        renew_cert
        ;;
    status)
        show_status
        ;;
    *)
        echo_error "Unknown mode: $MODE_ARG"
        echo "Usage: ./start-macos.sh [practice|workshop|performance|renew|dns|status] [--watch]"
        exit 1
        ;;
esac
