# Arbitrum Nitro TPS Battle Test

A comprehensive stress testing tool for measuring the maximum TPS (Transactions Per Second) of Arbitrum Nitro nodes. Features proper nonce management, parallel transaction broadcasting, and deep on-chain verification.

## Features

- 🚀 **High-throughput broadcasting** - Fire-and-forget with configurable concurrency
- 🔢 **Smart nonce management** - Multiple sender accounts for parallel nonce sequences
- ✅ **Deep verification** - Verifies each transaction exists on-chain with correct data
- 📊 **Detailed metrics** - TPS calculations, error breakdowns, block-by-block analysis
- ⚡ **Pre-signing** - Signs all transactions upfront for maximum broadcast speed

## Prerequisites

1. **Running Arbitrum Nitro Dev Node**

   ```bash
   git clone https://github.com/OffchainLabs/nitro-devnode.git
   cd nitro-devnode
   ./run-dev-node.sh
   ```

2. **Node.js** v18 or higher

## Installation

```bash
git clone https://github.com/GreatSoshiant/tps_test.git
cd arbitrum-tps-test
npm install
```

## Quick Start

```bash
# Quick test (1000 txs)
npm run quick

# Medium test (3000 txs)
npm run medium

# Stress test (10000 txs)
npm run stress
```

## Usage

```bash
node tps-test.js [options]
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--txCount=N` | Total transactions to send | 1000 |
| `--senders=N` | Number of sender accounts | 50 |
| `--concurrent=N` | Max concurrent HTTP requests | 200 |
| `--txValue=N` | ETH value per transaction | 0.00000001 |
| `--fundingAmount=N` | ETH to fund each sender | 0.01 |
| `--gasMultiplier=N` | Gas price multiplier (for fee spikes) | 2 |
| `--txType=TYPE` | Transaction type (eth_transfer) | eth_transfer |
| `--rpcUrl=URL` | RPC endpoint | http://127.0.0.1:8547 |
| `--verifyAll` | Fetch & verify every tx individually | false |

### Examples

```bash
# High TPS test
node tps-test.js --txCount=50000 --senders=500 --concurrent=500

# With full verification
node tps-test.js --txCount=5000 --senders=100 --verifyAll

# Custom RPC
node tps-test.js --rpcUrl=http://localhost:8545 --txCount=1000
```

## Architecture

```
tps-test.js          # Main script (broadcasting, verification, reporting)
payload-generator.js # Transaction payload generation (modular, extensible)
```

### Payload Generator

The `payload-generator.js` module handles transaction generation. Currently supports:
- `eth_transfer` - Simple ETH transfers

Future transaction types can be easily added:
- `erc20_transfer` - ERC20 token transfers
- `contract_call` - Smart contract interactions
- `mixed` - Mix of different transaction types

## How It Works

### 1. Account Setup
Creates multiple sender wallets and funds them from the pre-funded dev account. More senders = more parallel nonce sequences = higher throughput.

### 2. Payload Generation (payload-generator.js)
Generates transaction payloads based on `--txType`:
- Fetches nonces for all senders in parallel
- Creates transactions with proper gas pricing
- Returns unsigned transactions for signing

### 3. Transaction Signing
Pre-signs all transactions with:
- Sequential nonces per sender
- EIP-1559 gas pricing with configurable buffer
- Fixed gas limit (21000 for ETH transfers)

### 4. Parallel Broadcasting
Uses a worker pool to broadcast pre-signed transactions with high concurrency. No waiting for individual responses.

### 5. Verification
Three levels of verification:
- **Block-based**: Checks tx hashes exist in blocks
- **Sample verification**: Fetches 10 random txs directly
- **Full verification** (`--verifyAll`): Fetches every tx individually (worker pool for speed)

### 6. TPS Analysis
Calculates TPS based on:
- Block timestamps (coarse, second precision)
- Actual broadcast duration (more accurate)
- Only counts verified, confirmed transactions

## Output Example

```
🔥 Arbitrum Nitro TPS Battle Test
==================================================

🔗 Connecting to http://127.0.0.1:8547...
✅ Connected to chain ID: 412346

📦 Creating 500 sender accounts...
✅ Created 500 wallets

💸 Funding 500 sender accounts...
✅ Funded 500/500 sender accounts

🔧 Preparing 10000 transactions...
✅ Prepared 10000 transactions across 500 senders

✍️  Pre-signing 10000 transactions...
✅ Pre-signed 10000 transactions in 4.2s

🚀 Broadcasting 10000 transactions...
✅ Broadcast complete in 8.5s (1176 tx/s)
   Successful: 10000 | Failed: 0

⏳ Waiting for 10000 transactions to be mined...
✅ Confirmed 10000 transactions in 2.1s

🔍 VERIFICATION (checking tx hashes in blocks)...
   ✓ Hash found on-chain:      10000/10000
   ✓ CONFIRMED (status=1):     10000

🏆 TPS RESULTS:
   ┌─────────────────────────────────────────────────────────────┐
   │  📍 INCLUDED TPS (on-chain, any status):                    │
   │     Block-timestamp:       1250.00 tx/s                     │
   │     Broadcast-duration:    1176.47 tx/s                     │
   │                                                             │
   │  ✅ CONFIRMED TPS (status=1, successful execution):         │
   │     Block-timestamp:       1250.00 tx/s                     │
   │     Broadcast-duration:    1176.47 tx/s                     │
   └─────────────────────────────────────────────────────────────┘

   📈 Success Rate: 100.00% (10000/10000)
```

## Error Handling

The tool tracks and categorizes broadcast errors:

- ⛽ **Gas price too low** - Base fee increased during test (increase `--gasMultiplier`)
- 🔢 **Nonce too low/high** - Nonce management issues
- 📋 **Already known** - Duplicate transaction
- 💸 **Insufficient funds** - Account ran out of ETH
- ⏱️ **Timeout** - RPC timeout
- 🔌 **Connection error** - Network issues

## Tips for Maximum TPS

1. **More senders** = more parallel nonce sequences
   ```bash
   --senders=500
   ```

2. **Higher concurrency** = more parallel HTTP requests
   ```bash
   --concurrent=500
   ```

3. **Higher gas multiplier** = fewer gas price failures
   ```bash
   --gasMultiplier=3
   ```

4. **Optimal stress test configuration**:
   ```bash
   node tps-test.js --txCount=50000 --senders=500 --concurrent=500 --gasMultiplier=3
   ```

## Pre-funded Dev Account

The Nitro dev node comes with a pre-funded account:
- **Address**: `0x3f1Eae7D46d88F08fc2F8ed27FCb2AB183EB2d0E`
- **Private Key**: `0xb6b15c8cb491557369f3c7d2c287b053eb229daa9c22138887752191c9520659`

## License

MIT
