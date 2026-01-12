/**
 * Terminal UI Utilities
 * Beautiful console output for TPS testing
 */

// =============================================================================
// ANSI Color Codes
// =============================================================================

export const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  
  // Foreground colors
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  
  // Bright foreground
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
  brightWhite: '\x1b[97m',
  
  // Background colors
  bgBlack: '\x1b[40m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgWhite: '\x1b[47m',
};

// =============================================================================
// Styled Text Helpers
// =============================================================================

export const style = {
  success: (text) => `${colors.brightGreen}${text}${colors.reset}`,
  error: (text) => `${colors.brightRed}${text}${colors.reset}`,
  warning: (text) => `${colors.brightYellow}${text}${colors.reset}`,
  info: (text) => `${colors.brightCyan}${text}${colors.reset}`,
  highlight: (text) => `${colors.brightMagenta}${text}${colors.reset}`,
  dim: (text) => `${colors.dim}${text}${colors.reset}`,
  bold: (text) => `${colors.bold}${text}${colors.reset}`,
  value: (text) => `${colors.brightWhite}${colors.bold}${text}${colors.reset}`,
  label: (text) => `${colors.cyan}${text}${colors.reset}`,
};

// =============================================================================
// Box Drawing
// =============================================================================

const box = {
  topLeft: '╭',
  topRight: '╮',
  bottomLeft: '╰',
  bottomRight: '╯',
  horizontal: '─',
  vertical: '│',
  teeRight: '├',
  teeLeft: '┤',
};

export function drawBox(title, content, width = 60) {
  const lines = [];
  const innerWidth = width - 2;
  
  // Top border with title
  const titlePadded = title ? ` ${title} ` : '';
  const titleLen = title ? titlePadded.length : 0;
  const leftPad = Math.floor((innerWidth - titleLen) / 2);
  const rightPad = innerWidth - titleLen - leftPad;
  
  lines.push(
    `${colors.cyan}${box.topLeft}${box.horizontal.repeat(leftPad)}${colors.reset}` +
    `${colors.bold}${colors.brightWhite}${titlePadded}${colors.reset}` +
    `${colors.cyan}${box.horizontal.repeat(rightPad)}${box.topRight}${colors.reset}`
  );
  
  // Content lines
  const contentLines = content.split('\n');
  for (const line of contentLines) {
    const stripped = line.replace(/\x1b\[[0-9;]*m/g, '');
    const padding = innerWidth - stripped.length;
    lines.push(
      `${colors.cyan}${box.vertical}${colors.reset}` +
      `${line}${' '.repeat(Math.max(0, padding))}` +
      `${colors.cyan}${box.vertical}${colors.reset}`
    );
  }
  
  // Bottom border
  lines.push(
    `${colors.cyan}${box.bottomLeft}${box.horizontal.repeat(innerWidth)}${box.bottomRight}${colors.reset}`
  );
  
  return lines.join('\n');
}

// =============================================================================
// Banner
// =============================================================================

export function printBanner() {
  const banner = `
${colors.brightCyan}${colors.bold}
  ████████╗██████╗ ███████╗    ████████╗███████╗███████╗████████╗
  ╚══██╔══╝██╔══██╗██╔════╝    ╚══██╔══╝██╔════╝██╔════╝╚══██╔══╝
     ██║   ██████╔╝███████╗       ██║   █████╗  ███████╗   ██║   
     ██║   ██╔═══╝ ╚════██║       ██║   ██╔══╝  ╚════██║   ██║   
     ██║   ██║     ███████║       ██║   ███████╗███████║   ██║   
     ╚═╝   ╚═╝     ╚══════╝       ╚═╝   ╚══════╝╚══════╝   ╚═╝   
${colors.reset}
${colors.dim}  Arbitrum Nitro Battle Test Tool${colors.reset}
${colors.dim}  ─────────────────────────────────────────────────────────${colors.reset}
`;
  console.log(banner);
}

// =============================================================================
// Section Headers
// =============================================================================

export function printSection(title, icon = '📦') {
  const width = 60;
  const line = '─'.repeat(width);
  console.log(`\n${colors.cyan}${line}${colors.reset}`);
  console.log(`${icon}  ${colors.bold}${colors.brightWhite}${title}${colors.reset}`);
  console.log(`${colors.cyan}${line}${colors.reset}`);
}

export function printSubSection(title) {
  console.log(`\n${colors.dim}──${colors.reset} ${colors.bold}${title}${colors.reset}`);
}

// =============================================================================
// Progress Bar
// =============================================================================

export function progressBar(current, total, width = 30, label = '') {
  const percent = Math.min(100, Math.round((current / total) * 100));
  const filled = Math.round((current / total) * width);
  const empty = width - filled;
  
  const bar = 
    `${colors.brightGreen}${'█'.repeat(filled)}${colors.reset}` +
    `${colors.dim}${'░'.repeat(empty)}${colors.reset}`;
  
  const percentStr = `${percent}%`.padStart(4);
  const countStr = `${current}/${total}`.padStart(12);
  
  return `${label}${bar} ${colors.brightWhite}${percentStr}${colors.reset} ${colors.dim}${countStr}${colors.reset}`;
}

export function updateProgress(current, total, width = 30, prefix = '', suffix = '') {
  const bar = progressBar(current, total, width);
  process.stdout.write(`\r${prefix}${bar}${suffix}`);
}

// =============================================================================
// Spinner
// =============================================================================

const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function createSpinner(text) {
  let frameIndex = 0;
  let interval = null;
  
  return {
    start() {
      interval = setInterval(() => {
        const frame = spinnerFrames[frameIndex];
        process.stdout.write(`\r${colors.cyan}${frame}${colors.reset} ${text}`);
        frameIndex = (frameIndex + 1) % spinnerFrames.length;
      }, 80);
    },
    stop(finalText, success = true) {
      if (interval) {
        clearInterval(interval);
        const icon = success ? `${colors.brightGreen}✓${colors.reset}` : `${colors.brightRed}✗${colors.reset}`;
        process.stdout.write(`\r${icon} ${finalText}\n`);
      }
    },
  };
}

// =============================================================================
// Table
// =============================================================================

export function printTable(headers, rows, columnWidths = null) {
  if (!columnWidths) {
    columnWidths = headers.map((h, i) => {
      const maxContent = Math.max(h.length, ...rows.map(r => String(r[i] || '').length));
      return Math.min(30, maxContent);
    });
  }
  
  const formatRow = (cells, isHeader = false) => {
    const formatted = cells.map((cell, i) => {
      const str = String(cell || '');
      const width = columnWidths[i];
      return str.padEnd(width).slice(0, width);
    });
    
    const color = isHeader ? colors.bold : '';
    return `${color}${formatted.join(' │ ')}${colors.reset}`;
  };
  
  const separator = columnWidths.map(w => '─'.repeat(w)).join('─┼─');
  
  console.log(formatRow(headers, true));
  console.log(`${colors.dim}${separator}${colors.reset}`);
  rows.forEach(row => console.log(formatRow(row)));
}

// =============================================================================
// Status Messages
// =============================================================================

export function success(msg) {
  console.log(`${colors.brightGreen}✓${colors.reset} ${msg}`);
}

export function error(msg) {
  console.log(`${colors.brightRed}✗${colors.reset} ${msg}`);
}

export function warning(msg) {
  console.log(`${colors.brightYellow}⚠${colors.reset} ${msg}`);
}

export function info(msg) {
  console.log(`${colors.brightCyan}ℹ${colors.reset} ${msg}`);
}

export function step(num, msg) {
  console.log(`${colors.cyan}[${num}]${colors.reset} ${msg}`);
}

// =============================================================================
// Key-Value Display
// =============================================================================

export function printKeyValue(key, value, indent = 0) {
  const padding = ' '.repeat(indent);
  console.log(`${padding}${colors.dim}${key}:${colors.reset} ${colors.brightWhite}${value}${colors.reset}`);
}

export function printStats(stats, indent = 3) {
  const padding = ' '.repeat(indent);
  for (const [key, value] of Object.entries(stats)) {
    console.log(`${padding}${colors.dim}•${colors.reset} ${key}: ${colors.brightWhite}${value}${colors.reset}`);
  }
}

// =============================================================================
// Results Box
// =============================================================================

export function printResultsBox(title, results) {
  const width = 62;
  const innerWidth = width - 4;
  
  console.log(`\n${colors.brightCyan}╔${'═'.repeat(width - 2)}╗${colors.reset}`);
  
  // Title
  const titlePadded = title.padStart(Math.floor((innerWidth + title.length) / 2)).padEnd(innerWidth);
  console.log(`${colors.brightCyan}║${colors.reset} ${colors.bold}${colors.brightWhite}${titlePadded}${colors.reset} ${colors.brightCyan}║${colors.reset}`);
  
  console.log(`${colors.brightCyan}╟${'─'.repeat(width - 2)}╢${colors.reset}`);
  
  // Results
  for (const [label, value] of Object.entries(results)) {
    const labelStr = label.padEnd(35);
    const valueStr = String(value).padStart(innerWidth - 35 - 2);
    console.log(`${colors.brightCyan}║${colors.reset} ${colors.dim}${labelStr}${colors.reset}${colors.brightGreen}${colors.bold}${valueStr}${colors.reset} ${colors.brightCyan}║${colors.reset}`);
  }
  
  console.log(`${colors.brightCyan}╚${'═'.repeat(width - 2)}╝${colors.reset}`);
}

// =============================================================================
// TPS Results Display
// =============================================================================

export function printTPSResults(included, confirmed) {
  const width = 64;
  
  console.log(`\n${colors.brightCyan}╔${'═'.repeat(width - 2)}╗${colors.reset}`);
  console.log(`${colors.brightCyan}║${colors.reset}${' '.repeat(width - 2)}${colors.brightCyan}║${colors.reset}`);
  
  // Included TPS
  console.log(`${colors.brightCyan}║${colors.reset}  📍 ${colors.bold}INCLUDED TPS${colors.reset} (on-chain, any status)${' '.repeat(18)}${colors.brightCyan}║${colors.reset}`);
  console.log(`${colors.brightCyan}║${colors.reset}     Block-timestamp:    ${colors.brightWhite}${colors.bold}${included.blockTps.toFixed(2).padStart(12)}${colors.reset} tx/s${' '.repeat(13)}${colors.brightCyan}║${colors.reset}`);
  console.log(`${colors.brightCyan}║${colors.reset}     Broadcast-duration: ${colors.brightWhite}${colors.bold}${included.broadcastTps.toFixed(2).padStart(12)}${colors.reset} tx/s${' '.repeat(13)}${colors.brightCyan}║${colors.reset}`);
  
  console.log(`${colors.brightCyan}║${colors.reset}${' '.repeat(width - 2)}${colors.brightCyan}║${colors.reset}`);
  
  // Confirmed TPS
  console.log(`${colors.brightCyan}║${colors.reset}  ✅ ${colors.bold}${colors.brightGreen}CONFIRMED TPS${colors.reset} (status=1, successful)${' '.repeat(14)}${colors.brightCyan}║${colors.reset}`);
  console.log(`${colors.brightCyan}║${colors.reset}     Block-timestamp:    ${colors.brightGreen}${colors.bold}${confirmed.blockTps.toFixed(2).padStart(12)}${colors.reset} tx/s${' '.repeat(13)}${colors.brightCyan}║${colors.reset}`);
  console.log(`${colors.brightCyan}║${colors.reset}     Broadcast-duration: ${colors.brightGreen}${colors.bold}${confirmed.broadcastTps.toFixed(2).padStart(12)}${colors.reset} tx/s${' '.repeat(13)}${colors.brightCyan}║${colors.reset}`);
  
  console.log(`${colors.brightCyan}║${colors.reset}${' '.repeat(width - 2)}${colors.brightCyan}║${colors.reset}`);
  console.log(`${colors.brightCyan}╚${'═'.repeat(width - 2)}╝${colors.reset}`);
}

// =============================================================================
// Format Helpers
// =============================================================================

export function formatDuration(ms) {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60000).toFixed(2)}m`;
}

export function formatNumber(num) {
  return num.toLocaleString();
}

export function formatPercent(value, total) {
  if (total === 0) return '0%';
  return `${((value / total) * 100).toFixed(1)}%`;
}

// =============================================================================
// Clear Line
// =============================================================================

export function clearLine() {
  process.stdout.write('\r\x1b[K');
}

export default {
  colors,
  style,
  drawBox,
  printBanner,
  printSection,
  printSubSection,
  progressBar,
  updateProgress,
  createSpinner,
  printTable,
  success,
  error,
  warning,
  info,
  step,
  printKeyValue,
  printStats,
  printResultsBox,
  printTPSResults,
  formatDuration,
  formatNumber,
  formatPercent,
  clearLine,
};
