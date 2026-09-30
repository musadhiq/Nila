#!/usr/bin/env bash
#
# Nila — Linux development environment setup.
#
# Prepares an Ubuntu/Debian-based machine so Nila can be built and run with:
#
#     npm run tauri dev
#
# What it does:
#   1. Detects the Linux distribution (Ubuntu/Debian family only for auto-setup)
#   2. Installs Tauri 2.x native build dependencies via apt (sudo, only if missing)
#   3. Installs Node.js 20+ (user-local; never touches system node or shell rc files)
#   4. Installs Rust via rustup (official installer only; never apt)
#   5. Installs npm dependencies (npm ci when package-lock.json exists)
#   6. Validates: cargo metadata, frontend build, unit tests, Tauri build
#
# Safe to run multiple times — every step checks before installing anything.
#
# Usage:
#     ./scripts/setup-linux.sh [--skip-tauri-build]
#
# The full `npm run tauri build` validation can take a long time on first run
# (it compiles the whole Tauri stack). Pass --skip-tauri-build to skip it.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SKIP_TAURI_BUILD=0
for arg in "$@"; do
    case "$arg" in
        --skip-tauri-build) SKIP_TAURI_BUILD=1 ;;
        -h | --help)
            sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
            exit 0
            ;;
        *)
            echo "Unknown option: $arg" >&2
            echo "Usage: $0 [--skip-tauri-build]" >&2
            exit 2
            ;;
    esac
done

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1; then
    BOLD="$(tput bold)"
    RED="$(tput setaf 1)"
    GREEN="$(tput setaf 2)"
    YELLOW="$(tput setaf 3)"
    RESET="$(tput sgr0)"
else
    BOLD=""
    RED=""
    GREEN=""
    YELLOW=""
    RESET=""
fi

step() { echo; echo "${BOLD}==>${RESET} ${BOLD}$*${RESET}"; }
ok() { echo "  ${GREEN}OK${RESET} $*"; }
note() { echo "  ${YELLOW}..${RESET} $*"; }
have() { command -v "$1" >/dev/null 2>&1; }

die() {
    echo >&2
    echo "${RED}ERROR:${RESET} $*" >&2
    exit 1
}

# Compare dotted versions: version_ge "20.11.0" "20" -> true (0)
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

# ---------------------------------------------------------------------------
# Status tracking for the final summary
# ---------------------------------------------------------------------------

NODE_STATUS="MISSING"
NPM_STATUS="MISSING"
RUST_STATUS="MISSING"
CARGO_STATUS="MISSING"
TAURI_DEPS_STATUS="MISSING"
NPM_DEPS_STATUS="MISSING"
CARGO_METADATA_STATUS="MISSING"
FRONTEND_BUILD_STATUS="MISSING"
TESTS_STATUS="MISSING"
TAURI_BUILD_STATUS="SKIPPED"

NODE_INSTALL_NOTE=""

# ---------------------------------------------------------------------------
# 1. Distribution detection
# ---------------------------------------------------------------------------

step "Detecting Linux distribution"

if [[ ! -f /etc/os-release ]]; then
    die "Cannot detect the Linux distribution (/etc/os-release not found).

Nila's automatic Linux setup currently supports Ubuntu/Debian-based systems.
Please install the required Tauri/Rust dependencies manually."
fi

# shellcheck disable=SC1091
. /etc/os-release
DISTRO_ID="${ID:-unknown}"
DISTRO_LIKE="${ID_LIKE:-}"
DISTRO_PRETTY="${PRETTY_NAME:-$DISTRO_ID}"

SUPPORTED_DISTRO=0
case "$DISTRO_ID" in
    ubuntu | debian | linuxmint | pop) SUPPORTED_DISTRO=1 ;;
esac
if [[ $SUPPORTED_DISTRO -eq 0 ]] && [[ "$DISTRO_LIKE" == *debian* || "$DISTRO_LIKE" == *ubuntu* ]]; then
    if have apt-get; then
        SUPPORTED_DISTRO=1
    fi
fi

if [[ $SUPPORTED_DISTRO -eq 0 ]]; then
    die "Nila's automatic Linux setup currently supports Ubuntu/Debian-based systems.

Your distribution: ${DISTRO_PRETTY}

Please install the required Tauri/Rust dependencies manually:
  - Node.js 20+          https://nodejs.org/
  - Rust (via rustup)    https://rustup.rs/
  - Tauri 2.x Linux prerequisites
                         https://v2.tauri.app/start/prerequisites/"
fi

ok "Distribution: ${DISTRO_PRETTY}"

# ---------------------------------------------------------------------------
# 2. Tauri 2.x native dependencies (apt)
# ---------------------------------------------------------------------------
#
# Verified against the Tauri v2 prerequisites for Linux
# (https://v2.tauri.app/start/prerequisites/):
#   libwebkit2gtk-4.1-dev, build-essential, curl, wget, file,
#   libxdo-dev, libssl-dev, libayatana-appindicator3-dev, librsvg2-dev
# plus pkg-config, which several -sys crates probe for.

step "Installing Tauri 2.x native dependencies"

if ! have sudo; then
    die "sudo was not found.

System packages (Tauri's native dependencies) require sudo.
Please run this script as a user with sudo access, or install sudo first."
fi

if ! sudo -v; then
    die "Could not obtain sudo access.

System packages (Tauri's native dependencies) require sudo.
Check that your user is in the sudo group, then re-run this script."
fi

APT_UPDATED=0
apt_update_once() {
    if [[ $APT_UPDATED -eq 0 ]]; then
        note "Running apt-get update (once for this script)…"
        if ! sudo DEBIAN_FRONTEND=noninteractive apt-get update; then
            die "apt-get update failed.

Check your network connection and that your apt sources are reachable,
then re-run this script."
        fi
        APT_UPDATED=1
    fi
}

TAURI_PKGS=(
    build-essential
    curl
    wget
    file
    pkg-config
    libssl-dev
    libxdo-dev
    librsvg2-dev
)
# AppIndicator is optional for development (Nila does not use a tray yet);
# install it when available, warn when it is not.
APPINDICATOR_PKG="libayatana-appindicator3-dev"
WEBKIT_PKG="libwebkit2gtk-4.1-dev"
WEBKIT_FALLBACK_PKG="libwebkit2gtk-4.0-dev"

MISSING_PKGS=()
for pkg in "${TAURI_PKGS[@]}"; do
    if ! dpkg -s "$pkg" >/dev/null 2>&1; then
        MISSING_PKGS+=("$pkg")
    fi
done

# WebKit: prefer 4.1 (Tauri 2 default), fall back to 4.0 on older distros.
WEBKIT_CHOSEN=""
if ! dpkg -s "$WEBKIT_PKG" >/dev/null 2>&1 && ! dpkg -s "$WEBKIT_FALLBACK_PKG" >/dev/null 2>&1; then
    apt_update_once
    if apt-cache show "$WEBKIT_PKG" 2>/dev/null | grep -q '^Package:'; then
        WEBKIT_CHOSEN="$WEBKIT_PKG"
    elif apt-cache show "$WEBKIT_FALLBACK_PKG" 2>/dev/null | grep -q '^Package:'; then
        WEBKIT_CHOSEN="$WEBKIT_FALLBACK_PKG"
        note "Using ${WEBKIT_FALLBACK_PKG} (4.1 not available on ${DISTRO_PRETTY})."
        note "Tauri 2 prefers WebKitGTK 4.1; if the build fails, consider a newer distro release."
    else
        die "Neither ${WEBKIT_PKG} nor ${WEBKIT_FALLBACK_PKG} is available via apt.

Tauri on Linux renders with WebKitGTK, so one of these packages is required.
On Ubuntu 22.04+/Debian 12+ install ${WEBKIT_PKG}; on older releases the
4.0 variant may exist. Enable the universe repository on Ubuntu if needed,
then re-run this script."
    fi
    MISSING_PKGS+=("$WEBKIT_CHOSEN")
fi

APPINDICATOR_AVAILABLE=1
if ! dpkg -s "$APPINDICATOR_PKG" >/dev/null 2>&1; then
    apt_update_once
    if apt-cache show "$APPINDICATOR_PKG" 2>/dev/null | grep -q '^Package:'; then
        MISSING_PKGS+=("$APPINDICATOR_PKG")
    else
        APPINDICATOR_AVAILABLE=0
        note "${APPINDICATOR_PKG} is not available on ${DISTRO_PRETTY} — skipping."
        note "Only the (future) system-tray feature needs it; the app builds without it."
    fi
fi

if [[ ${#MISSING_PKGS[@]} -eq 0 ]]; then
    ok "Required system packages already installed."
else
    note "Installing missing packages: ${MISSING_PKGS[*]}"
    apt_update_once
    if ! sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "${MISSING_PKGS[@]}"; then
        die "apt-get install failed.

Some Tauri native dependencies could not be installed.
Re-run with more verbosity to see which package failed:
    sudo apt-get install ${MISSING_PKGS[*]}"
    fi
fi

if [[ $APPINDICATOR_AVAILABLE -eq 1 ]]; then
    TAURI_DEPS_STATUS="OK"
    ok "Tauri native dependencies installed."
else
    TAURI_DEPS_STATUS="OK (AppIndicator unavailable)"
    ok "Tauri native dependencies installed (AppIndicator skipped)."
fi

# ---------------------------------------------------------------------------
# 3. Node.js 20+
# ---------------------------------------------------------------------------
# Nila's README requires Node.js 20+. Never touches the system node and never
# modifies shell rc files; a user-local install is used when needed.

step "Checking Node.js (required: 20+)"

NODE_REQUIRED_MAJOR=20

node_major() {
    node --version 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/'
}

node_ok() {
    have node && [[ "$(node_major)" =~ ^[0-9]+$ ]] && version_ge "$(node_major)" "$NODE_REQUIRED_MAJOR"
}

install_node_tarball() {
    local arch ver url tmpdir dest
    arch="$(uname -m)"
    case "$arch" in
        x86_64) arch="x64" ;;
        aarch64) arch="arm64" ;;
        *)
            die "Unsupported CPU architecture for automatic Node.js install: $(uname -m).

Please install Node.js 20+ manually from https://nodejs.org/ and re-run."
            ;;
    esac
    note "Downloading the latest Node.js 20 release from the official nodejs.org distribution…"
    ver="$(curl -fsSL https://nodejs.org/dist/index.json | grep -o '"version":"v20\.[0-9]*\.[0-9]*"' | head -n1 | cut -d'"' -f4)"
    if [[ -z "$ver" ]]; then
        die "Could not determine the latest Node.js 20 release from nodejs.org.

Check your network connection, or install Node.js 20+ manually from
https://nodejs.org/ and re-run this script."
    fi
    url="https://nodejs.org/dist/${ver}/node-${ver}-linux-${arch}.tar.xz"
    dest="$HOME/.local/node-${ver}"
    if [[ ! -x "$dest/bin/node" ]]; then
        tmpdir="$(mktemp -d)"
        note "Fetching ${url}"
        if ! curl -fsSL "$url" -o "$tmpdir/node.tar.xz"; then
            rm -rf "$tmpdir"
            die "Failed to download Node.js from nodejs.org.

Check your network connection, or install Node.js 20+ manually from
https://nodejs.org/ and re-run this script."
        fi
        mkdir -p "$HOME/.local"
        tar -xJf "$tmpdir/node.tar.xz" -C "$HOME/.local"
        rm -rf "$tmpdir"
    fi
    export PATH="$dest/bin:$PATH"
    hash -r 2>/dev/null || true
    NODE_INSTALL_NOTE="Node.js was installed user-local at: $dest
To use it in new terminals, add this line to ~/.bashrc (or your shell's rc file):
    export PATH=\"$dest/bin:\$PATH\""
}

if node_ok; then
    ok "Node already installed: $(node --version)"
else
    if [[ -n "$(node_major 2>/dev/null)" ]]; then
        note "Found $(node --version) — Nila needs Node.js 20+. Installing a newer copy user-local…"
    else
        note "Node.js not found — installing Node.js 20 user-local…"
    fi
    if [[ -x "$HOME/.local/share/fnm/fnm" ]] || have fnm; then
        FNM_BIN="$(command -v fnm || echo "$HOME/.local/share/fnm/fnm")"
        note "Using existing fnm to install Node.js 20…"
        "$FNM_BIN" install 20
        eval "$("$FNM_BIN" env --shell bash)"
    elif [[ -s "$HOME/.nvm/nvm.sh" ]]; then
        note "Using existing nvm to install Node.js 20…"
        # shellcheck disable=SC1091
        . "$HOME/.nvm/nvm.sh"
        nvm install 20
        nvm use 20
    else
        install_node_tarball
    fi
    hash -r 2>/dev/null || true
    if ! node_ok; then
        die "Node.js installation did not produce a usable node >= 20.

Check:
    node --version
    npm --version
Then re-run this script."
    fi
    ok "Node installed: $(node --version)"
fi
NODE_STATUS="OK"

if have npm; then
    ok "npm available: $(npm --version)"
    NPM_STATUS="OK"
else
    die "npm was not found even though node is present.

A standard Node.js install always includes npm. If you installed node
manually, reinstall it from https://nodejs.org/ and re-run this script."
fi

# ---------------------------------------------------------------------------
# 4. Rust via rustup (never apt)
# ---------------------------------------------------------------------------

step "Checking Rust toolchain (rustup + stable)"

export PATH="$HOME/.cargo/bin:$PATH"
hash -r 2>/dev/null || true

rustc_version_ok() {
    local v
    v="$(rustc --version 2>/dev/null | sed -E 's/^rustc ([0-9]+\.[0-9]+).*/\1/')"
    [[ "$v" =~ ^[0-9]+\.[0-9]+$ ]] && version_ge "$v" "1.77"
}

if have cargo && have rustc && rustc_version_ok; then
    ok "Rust already installed: $(cargo --version) / $(rustc --version)"
else
    if have cargo || have rustc; then
        note "Found an incomplete or outdated Rust install — installing via rustup…"
    else
        note "Rust/Cargo not found — installing via the official rustup installer…"
    fi
    if ! curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable --no-modify-path; then
        die "The rustup installer failed.

Check your network connection and that curl works with TLS, then re-run.
Manual install: https://rustup.rs/"
    fi
    export PATH="$HOME/.cargo/bin:$PATH"
    hash -r 2>/dev/null || true
    if ! have cargo || ! have rustc; then
        die "Rust installed but cargo/rustc are still not on PATH.

The setup script added \$HOME/.cargo/bin to PATH for this session.
Check:
    ls ~/.cargo/bin
    cargo --version
    rustc --version
If ~/.cargo/bin is empty, re-run:  rustup toolchain install stable"
    fi
    ok "Rust installed: $(cargo --version) / $(rustc --version)"
fi

# Make sure the stable toolchain exists; never override the user's default
# toolchain choice without telling them.
if have rustup; then
    if ! rustup toolchain list 2>/dev/null | grep -q '^stable'; then
        note "Installing the stable toolchain…"
        rustup toolchain install stable
    fi
    ACTIVE_TOOLCHAIN="$(rustup show active-toolchain 2>/dev/null | awk '{print $1}' || true)"
    if [[ -z "$ACTIVE_TOOLCHAIN" || "$ACTIVE_TOOLCHAIN" == "no active toolchain" ]]; then
        note "Setting stable as the default toolchain…"
        rustup default stable
    elif [[ "$ACTIVE_TOOLCHAIN" != stable* ]]; then
        note "Keeping your existing default toolchain (${ACTIVE_TOOLCHAIN}); stable is installed too."
    fi
    if ! rustc_version_ok; then
        die "Your active Rust toolchain is older than 1.77 (Nila's minimum).

Nila's src-tauri/Cargo.toml declares rust-version = \"1.77\".
Update with:  rustup update
or switch default:  rustup default stable"
    fi
fi

RUST_STATUS="OK"
CARGO_STATUS="OK"
ok "rustup: $(rustup --version 2>/dev/null || echo 'not on PATH (optional)')"
ok "cargo: $(cargo --version)"
ok "rustc: $(rustc --version)"

# ---------------------------------------------------------------------------
# 5. npm dependencies (never with sudo)
# ---------------------------------------------------------------------------

step "Installing npm dependencies"

if [[ ! -f package.json ]]; then
    die "package.json not found in $REPO_ROOT.

Run this script from the Nila repository root (or a clone of
https://github.com/musadhiq/Nila)."
fi

if [[ -f package-lock.json ]]; then
    note "package-lock.json found — using npm ci for a reproducible install…"
    if ! npm ci; then
        die "npm ci failed.

Try removing node_modules and the lockfile inconsistency:
    rm -rf node_modules
    npm install
then re-run this script."
    fi
else
    note "No package-lock.json — using npm install…"
    if ! npm install; then
        die "npm install failed. Check the npm output above for the cause."
    fi
fi
NPM_DEPS_STATUS="OK"
ok "npm dependencies installed."

# ---------------------------------------------------------------------------
# 6. Validation
# ---------------------------------------------------------------------------

step "Validating: cargo metadata (reproduces the reported failure)"

# This is the exact command from the failure report. If it fails, stop here
# and explain instead of claiming success.
METADATA_ERR="$(mktemp)"
if cargo metadata --manifest-path src-tauri/Cargo.toml --no-deps --format-version 1 >"$METADATA_ERR.json" 2>"$METADATA_ERR"; then
    CARGO_METADATA_STATUS="OK"
    ok "cargo metadata succeeded."
else
    echo >&2
    echo "${RED}ERROR: cargo metadata failed.${RESET}" >&2
    echo >&2
    sed 's/^/    /' "$METADATA_ERR" >&2
    echo >&2
    die "Nila's Rust workspace could not be read.

This usually means a Rust toolchain component is missing or the crates.io
index could not be reached (network required on first run).

Check:
    cargo --version
    rustc --version
    rustup show

Fix the reported error above, then re-run this script."
fi
rm -f "$METADATA_ERR" "$METADATA_ERR.json"

step "Validating: frontend build (npm run build)"
if npm run build; then
    FRONTEND_BUILD_STATUS="OK"
    ok "Frontend build succeeded."
else
    die "npm run build failed.

The TypeScript/Vite frontend did not compile. See the error output above —
it is usually a type error in src/. Fix it and re-run this script."
fi

step "Validating: unit tests (npm test)"
if npm test; then
    TESTS_STATUS="OK"
    ok "Unit tests passed."
else
    die "npm test failed. See the test output above, fix the failures, and re-run."
fi

if [[ $SKIP_TAURI_BUILD -eq 0 ]]; then
    step "Validating: Tauri build (npm run tauri build)"
    note "First run compiles the full Tauri stack — this can take a while."
    if npm run tauri build; then
        TAURI_BUILD_STATUS="OK"
        ok "Tauri build succeeded."
    else
        die "npm run tauri build failed.

Common causes on Linux:
  - a native dependency from step 2 is missing (webkit2gtk, openssl, …)
  - no network access to crates.io / npm on first build
  - out of disk space (Rust target/ can grow to several GB)

Fix the reported error above, then re-run this script."
    fi
else
    note "Skipping Tauri build (--skip-tauri-build)."
fi

# ---------------------------------------------------------------------------
# 7. Summary
# ---------------------------------------------------------------------------

echo
echo "${BOLD}Nila Linux development environment${RESET}"
echo "${BOLD}===================================${RESET}"
echo
printf "  %-16s %s\n" "Node.js:" "$NODE_STATUS"
printf "  %-16s %s\n" "npm:" "$NPM_STATUS"
printf "  %-16s %s\n" "Rust:" "$RUST_STATUS"
printf "  %-16s %s\n" "Cargo:" "$CARGO_STATUS"
printf "  %-16s %s\n" "Tauri deps:" "$TAURI_DEPS_STATUS"
printf "  %-16s %s\n" "npm deps:" "$NPM_DEPS_STATUS"
printf "  %-16s %s\n" "Cargo metadata:" "$CARGO_METADATA_STATUS"
printf "  %-16s %s\n" "Frontend build:" "$FRONTEND_BUILD_STATUS"
printf "  %-16s %s\n" "Unit tests:" "$TESTS_STATUS"
printf "  %-16s %s\n" "Tauri build:" "$TAURI_BUILD_STATUS"
echo

if [[ -n "$NODE_INSTALL_NOTE" ]]; then
    echo "${YELLOW}Note:${RESET} ${NODE_INSTALL_NOTE}"
    echo
fi

echo "${BOLD}Start Nila with:${RESET}"
echo
echo "    npm run tauri dev"
echo
