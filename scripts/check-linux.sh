#!/usr/bin/env bash
#
# Nila — Linux development environment check.
#
# Diagnoses whether this machine can build and run Nila WITHOUT changing
# anything: no installs, no downloads, no sudo, no file modifications.
#
# Output is either:
#     Nila development environment: READY
# or:
#     Nila development environment: NOT READY
# followed by the precise list of missing requirements.
#
# Usage:
#     ./scripts/check-linux.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1; then
    BOLD="$(tput bold)"
    RED="$(tput setaf 1)"
    GREEN="$(tput setaf 2)"
    RESET="$(tput sgr0)"
else
    BOLD=""
    RED=""
    GREEN=""
    RESET=""
fi

have() { command -v "$1" >/dev/null 2>&1; }

version_ge() {
    local IFS=.
    local i a b x y
    read -r -a a <<<"$1"
    read -r -a b <<<"$2"
    for ((i = 0; i < ${#b[@]}; i++)); do
        x="${a[i]:-0}"
        y="${b[i]:-0}"
        x="${x%%[^0-9]*}"
        y="${y%%[^0-9]*}"
        [[ -z "$x" ]] && x=0
        [[ -z "$y" ]] && y=0
        ((10#$x > 10#$y)) && return 0
        ((10#$x < 10#$y)) && return 1
    done
    return 0
}

MISSING=()
check_ok() { echo "  ${GREEN}OK${RESET}      $*"; }
check_missing() {
    echo "  ${RED}MISSING${RESET}  $*"
    MISSING+=("$1")
}

echo "${BOLD}Nila development environment check${RESET}"
echo

# --- OS --------------------------------------------------------------------
if [[ "$(uname -s)" == "Linux" ]]; then
    if [[ -f /etc/os-release ]]; then
        # shellcheck disable=SC1091
        . /etc/os-release
        check_ok "Linux (${PRETTY_NAME:-unknown})"
    else
        check_ok "Linux"
    fi
else
    check_missing "Linux (this machine reports: $(uname -s))"
fi

# --- Node / npm -------------------------------------------------------------
NODE_MAJOR="$(node --version 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/')"
if [[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] && version_ge "$NODE_MAJOR" "20"; then
    check_ok "Node.js $(node --version) (>= 20 required)"
else
    check_missing "Node.js 20+ (found: ${NODE_MAJOR:-none})"
fi

if have npm; then
    check_ok "npm $(npm --version)"
else
    check_missing "npm"
fi

# --- Rust -------------------------------------------------------------------
export PATH="$HOME/.cargo/bin:$PATH"

if have rustc; then
    RUSTC_V="$(rustc --version 2>/dev/null | sed -E 's/^rustc ([0-9]+\.[0-9]+).*/\1/')"
    if [[ "$RUSTC_V" =~ ^[0-9]+\.[0-9]+$ ]] && version_ge "$RUSTC_V" "1.77"; then
        check_ok "rustc $(rustc --version) (>= 1.77 required)"
    else
        check_missing "rustc >= 1.77 (found: ${RUSTC_V:-unknown})"
    fi
else
    check_missing "rustc (install via https://rustup.rs/)"
fi

if have cargo; then
    check_ok "cargo $(cargo --version)"
else
    check_missing "cargo (install via https://rustup.rs/)"
fi

if have rustup; then
    check_ok "rustup $(rustup --version)"
else
    check_missing "rustup (recommended Rust manager: https://rustup.rs/)"
fi

# --- Native packages (Tauri 2.x, Debian/Ubuntu family) -----------------------
if have dpkg; then
    for pkg in build-essential curl wget file pkg-config libssl-dev libxdo-dev \
        librsvg2-dev libayatana-appindicator3-dev; do
        if dpkg -s "$pkg" >/dev/null 2>&1; then
            check_ok "package $pkg"
        else
            check_missing "package $pkg (sudo apt-get install $pkg)"
        fi
    done
    if dpkg -s libwebkit2gtk-4.1-dev >/dev/null 2>&1; then
        check_ok "package libwebkit2gtk-4.1-dev"
    elif dpkg -s libwebkit2gtk-4.0-dev >/dev/null 2>&1; then
        check_ok "package libwebkit2gtk-4.0-dev (4.1 preferred for Tauri 2)"
    else
        check_missing "package libwebkit2gtk-4.1-dev (sudo apt-get install libwebkit2gtk-4.1-dev)"
    fi
else
    check_missing "dpkg-based package check (non-Debian system?)"
fi

# --- Project dependencies ----------------------------------------------------
if [[ -f package.json ]]; then
    check_ok "package.json present"
else
    check_missing "package.json (are you in the Nila repo root?)"
fi

if [[ -d node_modules ]]; then
    check_ok "npm dependencies installed (node_modules present)"
else
    check_missing "npm dependencies (run: npm ci)"
fi

# --- cargo metadata (the exact failing command from the bug report) -----------
if have cargo && [[ -f src-tauri/Cargo.toml ]]; then
    if cargo metadata --manifest-path src-tauri/Cargo.toml --no-deps --format-version 1 >/dev/null 2>&1; then
        check_ok "cargo metadata (Rust workspace readable)"
    else
        check_missing "cargo metadata (run: cargo metadata --manifest-path src-tauri/Cargo.toml --no-deps --format-version 1)"
    fi
else
    check_missing "cargo metadata (cargo or src-tauri/Cargo.toml missing)"
fi

# --- Verdict ------------------------------------------------------------------
echo
if [[ ${#MISSING[@]} -eq 0 ]]; then
    echo "${BOLD}${GREEN}Nila development environment: READY${RESET}"
    echo
    echo "Start Nila with:  npm run tauri dev"
    exit 0
else
    echo "${BOLD}${RED}Nila development environment: NOT READY${RESET}"
    echo
    echo "Missing requirements:"
    for m in "${MISSING[@]}"; do
        echo "  - $m"
    done
    echo
    echo "Run ./scripts/setup-linux.sh to install them automatically"
    echo "(Ubuntu/Debian-based systems)."
    exit 1
fi
