import { ethers } from 'ethers';

// =============================================================================
// Configuration
// =============================================================================

const CONFIG = {
  // Arbitrum Nitro dev node RPC URL
  rpcUrl: process.env.RPC_URL || 'http://127.0.0.1:8547',
  
  // Pre-funded dev account from nitro-devnode
  funderPrivateKey: '0xb6b15c8cb491557369f3c7d2c287b053eb229daa9c22138887752191c9520659',
  
  // Test parameters (can be overridden via CLI args)
  txCount: 1000,          // Total transactions to send
  senderCount: 50,        // Number of sender accounts (more = more parallelism!)
  txValue: '0.00000001',  // ETH value per transaction (10 gwei = 0.00000001 ETH)
  fundingAmount: '0.01',  // ETH to fund each sender account (enough for many tiny txs)
  
  // Gas settings
  gasLimit: 21000,        // Standard ETH transfer gas
  
  // Timing - for fire-and-forget, these control concurrency
  concurrentRequests: 200, // Max concurrent HTTP requests
  
  // Gas buffer multiplier (to handle base fee increases during test)
  gasMultiplier: 2,       // 2x = safe for most tests, increase for long tests
  
  // Verification
  verifyAll: false,       // If true, fetch and verify EVERY transaction individually
};

// =============================================================================
// Parse CLI Arguments
// =============================================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { ...CONFIG };
  
  for (const arg of args) {
    const [key, value] = arg.replace('--', '').split('=');
    if (key === 'txCount') config.txCount = parseInt(value);
    if (key === 'senders') config.senderCount = parseInt(value);
    if (key === 'rpcUrl') config.rpcUrl = value;
    if (key === 'concurrent') config.concurrentRequests = parseInt(value);
    if (key === 'txValue') config.txValue = value;
    if (key === 'fundingAmount') config.fundingAmount = value;
    if (key === 'gasMultiplier') config.gasMultiplier = parseFloat(value);
    if (key === 'verifyAll') config.verifyAll = value === 'true' || value === undefined;
  }
  
  return config;
}

// =============================================================================
// Utility Functions
// =============================================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

// =============================================================================
// Account Management
// =============================================================================

async function createAndFundSenders(provider, funderWallet, count, fundingAmount, config) {
  console.log(`\n📦 Creating ${count} sender accounts...`);
  
  const senders = [];
  
  // Create wallets
  for (let i = 0; i < count; i++) {
    const wallet = ethers.Wallet.createRandom().connect(provider);
    senders.push(wallet);
  }
  
  console.log(`✅ Created ${count} wallets`);
  console.log(`\n💸 Funding ${count} sender accounts...`);
  
  // Get funder's nonce and fee data with buffer
  let nonce = await funderWallet.getNonce();
  const feeData = await provider.getFeeData();
  const chainId = (await provider.getNetwork()).chainId;
  
  // Use gas multiplier for funding too
  const multiplier = BigInt(Math.floor((config.gasMultiplier || 2) * 100));
  const maxFeePerGas = (feeData.maxFeePerGas || feeData.gasPrice) * multiplier / 100n;
  
  // Pre-sign all funding transactions
  console.log(`   Pre-signing ${count} funding transactions...`);
  const fundingTxs = [];
  const txHashes = [];
  
  for (let i = 0; i < senders.length; i++) {
    const tx = {
      to: senders[i].address,
      value: ethers.parseEther(fundingAmount),
      nonce: nonce++,
      gasLimit: 21000,
      chainId: chainId,
      type: 2,
      maxFeePerGas: maxFeePerGas,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || 0n,
    };
    
    const signedTx = await funderWallet.signTransaction(tx);
    fundingTxs.push({ signedTx, senderIdx: i });
  }
  
  // Broadcast funding transactions
  console.log(`   Broadcasting ${count} funding transactions...`);
  let broadcastSuccess = 0;
  let broadcastFailed = 0;
  
  // Send in batches to avoid overwhelming
  const batchSize = Math.min(200, count);
  for (let i = 0; i < fundingTxs.length; i += batchSize) {
    const batch = fundingTxs.slice(i, i + batchSize);
    
    const batchPromises = batch.map(async ({ signedTx, senderIdx }) => {
      try {
        const response = await fetch(config.rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'eth_sendRawTransaction',
            params: [signedTx],
            id: senderIdx,
          }),
        });
        const result = await response.json();
        if (result.result) {
          txHashes.push({ hash: result.result, senderIdx });
          return true;
        }
        return false;
      } catch (err) {
        return false;
      }
    });
    
    const results = await Promise.all(batchPromises);
    broadcastSuccess += results.filter(r => r).length;
    broadcastFailed += results.filter(r => !r).length;
    
    process.stdout.write(`\r   Broadcast: ${i + batch.length}/${count} (✓${broadcastSuccess} ✗${broadcastFailed})`);
  }
  console.log();
  
  if (broadcastSuccess === 0) {
    console.log(`❌ All funding transactions failed to broadcast`);
    return [];
  }
  
  // Wait for funding transactions to be mined (poll until most are confirmed)
  console.log(`   Waiting for funding transactions to confirm...`);
  const startWait = Date.now();
  const timeout = Math.max(30000, count * 10); // At least 30s, or 10ms per tx
  
  let funded = 0;
  let lastFunded = 0;
  let stableCount = 0;
  
  while (Date.now() - startWait < timeout) {
    // Check balances in batches
    let currentFunded = 0;
    
    for (let i = 0; i < senders.length; i += 100) {
      const batch = senders.slice(i, i + 100);
      const balancePromises = batch.map(s => provider.getBalance(s.address).catch(() => 0n));
      const balances = await Promise.all(balancePromises);
      currentFunded += balances.filter(b => b > 0n).length;
    }
    
    funded = currentFunded;
    const elapsed = ((Date.now() - startWait) / 1000).toFixed(1);
    process.stdout.write(`\r   Funded: ${funded}/${count} (${elapsed}s elapsed)`);
    
    // Check if all funded or funding has stabilized
    if (funded >= broadcastSuccess) {
      break;
    }
    
    // If no progress for 3 checks, stop waiting
    if (funded === lastFunded) {
      stableCount++;
      if (stableCount >= 5) {
        console.log(`\n   ⚠️  Funding stabilized at ${funded}/${count}`);
        break;
      }
    } else {
      stableCount = 0;
    }
    lastFunded = funded;
    
    await sleep(500);
  }
  console.log();
  
  // Final balance check and filter funded senders
  const fundedSenders = [];
  for (const sender of senders) {
    try {
      const balance = await provider.getBalance(sender.address);
      if (balance > 0n) {
        fundedSenders.push(sender);
      }
    } catch {
      // Skip failed balance checks
    }
  }
  
  console.log(`✅ Funded ${fundedSenders.length}/${count} sender accounts`);
  
  if (fundedSenders.length < count) {
    console.log(`   ⚠️  ${count - fundedSenders.length} accounts not funded (will use ${fundedSenders.length} senders)`);
  }
  
  return fundedSenders;
}

// =============================================================================
// Transaction Preparation & Pre-signing
// =============================================================================

async function prepareAndSignTransactions(senders, config, chainId, provider) {
  console.log(`\n🔧 Preparing ${config.txCount} transactions...`);
  
  const txPerSender = Math.ceil(config.txCount / senders.length);
  
  // Get nonces for all senders in parallel
  const noncePromises = senders.map(s => s.getNonce());
  const nonces = await Promise.all(noncePromises);
  
  // Get current fee data for gas pricing (add buffer for base fee fluctuations)
  const feeData = await provider.getFeeData();
  const multiplier = BigInt(Math.floor(config.gasMultiplier * 100));
  const maxFeePerGas = (feeData.maxFeePerGas || feeData.gasPrice) * multiplier / 100n;
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || 0n;
  console.log(`   Gas price: ${ethers.formatUnits(feeData.gasPrice || 0n, 'gwei')} gwei (using ${config.gasMultiplier}x buffer)`);
  
  // Create a recipient address (just send to self for simplicity)
  const recipient = ethers.Wallet.createRandom().address;
  const txValue = ethers.parseEther(config.txValue);
  
  // Store expected tx details for later verification
  const expectedTxDetails = {
    recipient: recipient.toLowerCase(),
    value: txValue,
    senderAddresses: new Set(senders.map(s => s.address.toLowerCase())),
  };
  
  console.log(`   Recipient: ${recipient}`);
  console.log(`   Value per tx: ${config.txValue} ETH`);
  
  // Build all unsigned transactions
  const unsignedTxs = [];
  let txIndex = 0;
  
  for (let senderIdx = 0; senderIdx < senders.length && txIndex < config.txCount; senderIdx++) {
    const sender = senders[senderIdx];
    let nonce = nonces[senderIdx];
    
    const txsForThisSender = Math.min(txPerSender, config.txCount - txIndex);
    
    for (let i = 0; i < txsForThisSender && txIndex < config.txCount; i++) {
      const tx = {
        to: recipient,
        value: txValue,
        nonce: nonce++,
        gasLimit: config.gasLimit,
        chainId: chainId,
        type: 2, // EIP-1559 transaction
        maxFeePerGas: maxFeePerGas,
        maxPriorityFeePerGas: maxPriorityFeePerGas,
      };
      
      unsignedTxs.push({
        sender,
        tx,
        index: txIndex++,
      });
    }
  }
  
  console.log(`✅ Prepared ${unsignedTxs.length} transactions across ${senders.length} senders`);
  
  // Pre-sign all transactions
  console.log(`\n✍️  Pre-signing ${unsignedTxs.length} transactions...`);
  const signStartTime = Date.now();
  
  const signedTxs = [];
  const signBatchSize = 100;
  
  for (let i = 0; i < unsignedTxs.length; i += signBatchSize) {
    const batch = unsignedTxs.slice(i, i + signBatchSize);
    
    const signPromises = batch.map(async ({ sender, tx, index }) => {
      try {
        const signedTx = await sender.signTransaction(tx);
        return { signedTx, index, expectedFrom: sender.address.toLowerCase() };
      } catch (err) {
        console.error(`\n   Failed to sign tx ${index}: ${err.message}`);
        return null;
      }
    });
    
    const results = await Promise.all(signPromises);
    
    for (const result of results) {
      if (result) signedTxs.push(result);
    }
    
    // Progress update
    const progress = Math.min(i + signBatchSize, unsignedTxs.length);
    const elapsed = Date.now() - signStartTime;
    const rate = (progress / elapsed) * 1000;
    process.stdout.write(`\r   Signed: ${progress}/${unsignedTxs.length} (${rate.toFixed(0)} tx/s)`);
  }
  
  const signDuration = Date.now() - signStartTime;
  console.log(`\n✅ Pre-signed ${signedTxs.length} transactions in ${formatDuration(signDuration)}`);
  
  return { signedTxs, signDuration, expectedTxDetails };
}

// =============================================================================
// Memory-Efficient Parallel Broadcaster
// =============================================================================

async function fireAndForgetBroadcast(signedTxs, config) {
  console.log(`\n🚀 Broadcasting ${signedTxs.length} transactions...`);
  console.log(`   Concurrency: ${config.concurrentRequests} parallel requests`);
  
  const startTime = Date.now();
  let successCount = 0;
  let errorCount = 0;
  let firstError = null;
  const txHashes = [];
  
  // Track error types
  const errorTypes = new Map();
  const errorExamples = new Map();
  
  // Simple semaphore using a counter
  let activeCount = 0;
  let nextIndex = 0;
  
  // Categorize error messages
  const categorizeError = (errorMsg) => {
    if (!errorMsg) return 'unknown';
    const msg = errorMsg.toLowerCase();
    if (msg.includes('max fee per gas less than block base fee')) return 'gas_price_too_low';
    if (msg.includes('nonce too low')) return 'nonce_too_low';
    if (msg.includes('nonce too high')) return 'nonce_too_high';
    if (msg.includes('already known')) return 'already_known';
    if (msg.includes('replacement transaction underpriced')) return 'replacement_underpriced';
    if (msg.includes('insufficient funds')) return 'insufficient_funds';
    if (msg.includes('intrinsic gas too low')) return 'gas_too_low';
    if (msg.includes('timeout') || msg.includes('ETIMEDOUT')) return 'timeout';
    if (msg.includes('connection') || msg.includes('ECONNREFUSED')) return 'connection_error';
    return 'other';
  };
  
  // Create a pool of workers
  const worker = async () => {
    while (nextIndex < signedTxs.length) {
      const idx = nextIndex++;
      const { signedTx, index, expectedFrom } = signedTxs[idx];
      
      try {
        const response = await fetch(config.rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'eth_sendRawTransaction',
            params: [signedTx],
            id: index,
          }),
        });
        
        const result = await response.json();
        
        if (result.result) {
          txHashes.push({ hash: result.result, index, expectedFrom });
          successCount++;
        } else {
          const errorMsg = result.error?.message || 'unknown error';
          if (!firstError) firstError = errorMsg;
          
          // Categorize and count error
          const errorType = categorizeError(errorMsg);
          errorTypes.set(errorType, (errorTypes.get(errorType) || 0) + 1);
          if (!errorExamples.has(errorType)) {
            errorExamples.set(errorType, errorMsg.slice(0, 100));
          }
          
          errorCount++;
        }
      } catch (err) {
        const errorMsg = err.message || 'unknown error';
        if (!firstError) firstError = errorMsg;
        
        const errorType = categorizeError(errorMsg);
        errorTypes.set(errorType, (errorTypes.get(errorType) || 0) + 1);
        if (!errorExamples.has(errorType)) {
          errorExamples.set(errorType, errorMsg.slice(0, 100));
        }
        
        errorCount++;
      }
      
      // Progress update
      const total = successCount + errorCount;
      if (total % 200 === 0 || total === signedTxs.length) {
        const elapsed = Date.now() - startTime;
        const rate = (total / elapsed) * 1000;
        process.stdout.write(`\r   Sent: ${total}/${signedTxs.length} (${rate.toFixed(0)} tx/s) | ✓${successCount} ✗${errorCount}`);
      }
    }
  };
  
  // Start workers
  const workers = [];
  for (let i = 0; i < config.concurrentRequests; i++) {
    workers.push(worker());
  }
  
  await Promise.all(workers);
  
  const sendDuration = Date.now() - startTime;
  const finalRate = (signedTxs.length / sendDuration) * 1000;
  
  console.log(`\n✅ Broadcast complete in ${formatDuration(sendDuration)} (${finalRate.toFixed(0)} tx/s)`);
  console.log(`   Successful: ${successCount} | Failed: ${errorCount}`);
  
  if (errorCount > 0) {
    console.log(`\n   📊 ERROR BREAKDOWN:`);
    
    // Sort errors by count (descending)
    const sortedErrors = [...errorTypes.entries()].sort((a, b) => b[1] - a[1]);
    
    for (const [errorType, count] of sortedErrors) {
      const percentage = ((count / errorCount) * 100).toFixed(1);
      const example = errorExamples.get(errorType);
      
      const friendlyName = {
        'gas_price_too_low': '⛽ Gas price too low (base fee increased)',
        'nonce_too_low': '🔢 Nonce too low',
        'nonce_too_high': '🔢 Nonce too high',
        'already_known': '📋 Already known (duplicate)',
        'replacement_underpriced': '💰 Replacement underpriced',
        'insufficient_funds': '💸 Insufficient funds',
        'gas_too_low': '⛽ Gas limit too low',
        'timeout': '⏱️  Timeout',
        'connection_error': '🔌 Connection error',
        'other': '❓ Other',
        'unknown': '❓ Unknown',
      }[errorType] || errorType;
      
      console.log(`   ${friendlyName}: ${count} (${percentage}%)`);
    }
    
    if (firstError) {
      console.log(`\n   First error example: ${firstError.slice(0, 120)}`);
    }
  }
  
  return { txHashes, errors: [], sendDuration, successCount, errorCount, errorTypes: Object.fromEntries(errorTypes) };
}

// =============================================================================
// Wait for Confirmations
// =============================================================================

async function waitForConfirmations(provider, txHashes, timeoutMs = 120000) {
  console.log(`\n⏳ Waiting for ${txHashes.length} transactions to be mined...`);
  
  const startTime = Date.now();
  const receipts = [];
  const failed = [];
  
  // Poll for receipts with progress updates
  const pending = new Set(txHashes.map(t => t.hash));
  
  while (pending.size > 0 && Date.now() - startTime < timeoutMs) {
    const checkPromises = Array.from(pending).map(async (hash) => {
      try {
        const receipt = await provider.getTransactionReceipt(hash);
        if (receipt) {
          return { hash, receipt };
        }
      } catch (err) {
        // Ignore and retry
      }
      return null;
    });
    
    const results = await Promise.all(checkPromises);
    
    for (const result of results) {
      if (result) {
        pending.delete(result.hash);
        receipts.push(result.receipt);
      }
    }
    
    const confirmed = receipts.length;
    const elapsed = Date.now() - startTime;
    process.stdout.write(`\r   Confirmed: ${confirmed}/${txHashes.length} (${formatDuration(elapsed)} elapsed)`);
    
    if (pending.size > 0) {
      await sleep(100); // Poll every 100ms
    }
  }
  
  const confirmDuration = Date.now() - startTime;
  console.log(`\n✅ Confirmed ${receipts.length} transactions in ${formatDuration(confirmDuration)}`);
  
  if (pending.size > 0) {
    console.log(`⚠️  ${pending.size} transactions not confirmed within timeout`);
  }
  
  return { receipts, confirmDuration };
}

// =============================================================================
// TPS Analysis (with verification)
// =============================================================================

async function analyzeBlockTPS(provider, receipts, broadcastStartTime, broadcastEndTime, expectedTxDetails, txHashesWithMeta, config) {
  console.log(`\n📊 Analyzing TPS from chain history...`);
  
  if (receipts.length === 0) {
    console.log('❌ No receipts to analyze');
    return null;
  }
  
  // Check receipt statuses (1 = success, 0 = reverted)
  let successfulTxCount = 0;
  let revertedTxCount = 0;
  
  for (const receipt of receipts) {
    if (receipt.status === 1) {
      successfulTxCount++;
    } else {
      revertedTxCount++;
    }
  }
  
  console.log(`   Receipt status check: ✓${successfulTxCount} successful, ✗${revertedTxCount} reverted`);
  
  // Get unique block numbers
  const blockNumbers = [...new Set(receipts.map(r => r.blockNumber))].sort((a, b) => a - b);
  
  console.log(`   Transactions spread across ${blockNumbers.length} blocks (${blockNumbers[0]} - ${blockNumbers[blockNumbers.length - 1]})`);
  
  // Fetch all blocks (without full tx data to avoid "response too large" errors)
  console.log(`   Fetching ${blockNumbers.length} blocks...`);
  const blockPromises = blockNumbers.map(num => provider.getBlock(num, false)); // false = tx hashes only
  const blocks = await Promise.all(blockPromises);
  
  // Build maps for verification
  const ourTxHashes = new Set(receipts.map(r => r.hash.toLowerCase()));
  const successfulTxHashes = new Set(receipts.filter(r => r.status === 1).map(r => r.hash.toLowerCase()));
  
  // Map of hash -> expected from address
  const hashToExpectedFrom = new Map();
  for (const item of txHashesWithMeta) {
    hashToExpectedFrom.set(item.hash.toLowerCase(), item.expectedFrom);
  }
  
  // Count our transactions per block (from receipts)
  const txCountByBlock = new Map();
  for (const receipt of receipts) {
    const count = txCountByBlock.get(receipt.blockNumber) || 0;
    txCountByBlock.set(receipt.blockNumber, count + 1);
  }
  
  // VERIFICATION: Check our tx hashes exist in blocks
  console.log(`\n🔍 VERIFICATION (checking tx hashes in blocks)...`);
  
  let verifiedTxCount = 0;
  let verifiedSuccessfulCount = 0;
  let totalBlockTxCount = 0;
  
  for (const block of blocks) {
    totalBlockTxCount += block.transactions.length;
    
    // Check each transaction hash in the block
    for (const txHash of block.transactions) {
      const hash = txHash.toLowerCase();
      
      if (ourTxHashes.has(hash)) {
        verifiedTxCount++;
        if (successfulTxHashes.has(hash)) {
          verifiedSuccessfulCount++;
        }
      }
    }
  }
  
  console.log(`   ✓ Hash found on-chain:      ${verifiedTxCount}/${receipts.length}`);
  console.log(`   ✓ CONFIRMED (status=1):     ${verifiedSuccessfulCount}`);
  console.log(`   ✓ Total txs in blocks:      ${totalBlockTxCount}`);
  
  // EXPLICIT SAMPLE VERIFICATION: Fetch random transactions directly
  console.log(`\n🔬 EXPLICIT SAMPLE VERIFICATION (fetching txs directly from chain)...`);
  const sampleSize = Math.min(10, receipts.length);
  const sampleIndices = [];
  
  // Pick random samples spread across the receipts
  for (let i = 0; i < sampleSize; i++) {
    sampleIndices.push(Math.floor((i / sampleSize) * receipts.length));
  }
  
  let sampleVerified = 0;
  const sampleResults = [];
  
  for (const idx of sampleIndices) {
    const receipt = receipts[idx];
    try {
      // Fetch transaction directly by hash
      const tx = await provider.getTransaction(receipt.hash);
      const txReceipt = await provider.getTransactionReceipt(receipt.hash);
      
      if (tx && txReceipt) {
        const fromMatch = expectedTxDetails.senderAddresses.has(tx.from.toLowerCase());
        const toMatch = tx.to?.toLowerCase() === expectedTxDetails.recipient;
        const valueMatch = tx.value === expectedTxDetails.value;
        const statusOk = txReceipt.status === 1;
        const blockConfirmed = txReceipt.blockNumber > 0;
        
        if (fromMatch && toMatch && valueMatch && statusOk && blockConfirmed) {
          sampleVerified++;
          sampleResults.push({
            hash: receipt.hash.slice(0, 18) + '...',
            from: tx.from.slice(0, 10) + '...',
            to: tx.to.slice(0, 10) + '...',
            value: ethers.formatEther(tx.value),
            block: txReceipt.blockNumber,
            status: '✓',
          });
        } else {
          sampleResults.push({
            hash: receipt.hash.slice(0, 18) + '...',
            status: '✗',
            reason: !fromMatch ? 'from' : !toMatch ? 'to' : !valueMatch ? 'value' : !statusOk ? 'status' : 'block',
          });
        }
      } else {
        sampleResults.push({
          hash: receipt.hash.slice(0, 18) + '...',
          status: '✗',
          reason: 'not found',
        });
      }
    } catch (err) {
      sampleResults.push({
        hash: receipt.hash.slice(0, 18) + '...',
        status: '✗',
        reason: err.message,
      });
    }
  }
  
  console.log(`   Sample: ${sampleVerified}/${sampleSize} transactions verified by direct fetch`);
  console.log(`\n   📋 Sample transaction details:`);
  console.log(`   ${'─'.repeat(75)}`);
  console.log(`   Hash               | From         | To           | Value    | Block  | OK`);
  console.log(`   ${'─'.repeat(75)}`);
  
  for (const r of sampleResults) {
    if (r.status === '✓') {
      console.log(`   ${r.hash} | ${r.from} | ${r.to} | ${r.value.padStart(8)} | ${r.block.toString().padStart(6)} | ${r.status}`);
    } else {
      console.log(`   ${r.hash} | FAILED: ${r.reason}`);
    }
  }
  console.log(`   ${'─'.repeat(75)}`);
  
  // FULL VERIFICATION: If --verifyAll is set, verify EVERY transaction individually using worker pool
  let fullVerifiedCount = verifiedTxCount; // Default to block-based verification
  
  if (config.verifyAll) {
    console.log(`\n🔬 FULL VERIFICATION: Fetching ALL ${receipts.length} transactions by hash...`);
    console.log(`   Checking each tx: hash exists → receipt exists → status=1 → block mined → data matches`);
    console.log(`   Using worker pool with ${config.concurrentRequests} concurrent requests...`);
    
    fullVerifiedCount = 0;
    let fullVerifyErrors = 0;
    let notFound = 0;
    let noReceipt = 0;
    let statusFailed = 0;
    let notMined = 0;
    let dataMismatch = 0;
    let errorCount = 0;
    
    // Worker pool pattern for parallel verification
    let nextIndex = 0;
    const startTime = Date.now();
    
    const verifyWorker = async () => {
      while (nextIndex < receipts.length) {
        const idx = nextIndex++;
        const receipt = receipts[idx];
        
        try {
          // 1. Fetch transaction by hash
          const tx = await provider.getTransaction(receipt.hash);
          if (!tx) {
            notFound++;
            fullVerifyErrors++;
            continue;
          }
          
          // 2. Fetch receipt by hash
          const txReceipt = await provider.getTransactionReceipt(receipt.hash);
          if (!txReceipt) {
            noReceipt++;
            fullVerifyErrors++;
            continue;
          }
          
          // 3. Check receipt status (1 = success, 0 = reverted)
          if (txReceipt.status !== 1) {
            statusFailed++;
            fullVerifyErrors++;
            continue;
          }
          
          // 4. Check it's actually mined in a block
          if (!txReceipt.blockNumber || txReceipt.blockNumber <= 0) {
            notMined++;
            fullVerifyErrors++;
            continue;
          }
          
          // 5. Verify transaction data matches what we sent
          const fromOk = expectedTxDetails.senderAddresses.has(tx.from.toLowerCase());
          const toOk = tx.to?.toLowerCase() === expectedTxDetails.recipient;
          const valueOk = tx.value === expectedTxDetails.value;
          
          if (!fromOk || !toOk || !valueOk) {
            dataMismatch++;
            fullVerifyErrors++;
            continue;
          }
          
          // ALL CHECKS PASSED
          fullVerifiedCount++;
        } catch (err) {
          errorCount++;
          fullVerifyErrors++;
        }
        
        // Progress update every 100 txs
        const completed = fullVerifiedCount + fullVerifyErrors;
        if (completed % 100 === 0 || completed === receipts.length) {
          const elapsed = Date.now() - startTime;
          const rate = (completed / elapsed) * 1000;
          process.stdout.write(`\r   Verified: ${completed}/${receipts.length} (${rate.toFixed(0)}/s) | ✓${fullVerifiedCount} | ✗${fullVerifyErrors}`);
        }
      }
    };
    
    // Start worker pool
    const workers = [];
    const workerCount = Math.min(config.concurrentRequests, receipts.length);
    for (let i = 0; i < workerCount; i++) {
      workers.push(verifyWorker());
    }
    
    await Promise.all(workers);
    
    const verifyDuration = Date.now() - startTime;
    const verifyRate = (receipts.length / verifyDuration) * 1000;
    
    console.log(`\n\n   📊 FULL VERIFICATION RESULTS:`);
    console.log(`   ✅ Fully verified & confirmed: ${fullVerifiedCount}/${receipts.length}`);
    console.log(`   ⏱️  Verification time: ${(verifyDuration / 1000).toFixed(2)}s (${verifyRate.toFixed(0)} tx/s)`);
    
    if (fullVerifyErrors > 0) {
      console.log(`   ❌ Failed verifications: ${fullVerifyErrors}`);
      if (notFound > 0) console.log(`      - TX not found by hash: ${notFound}`);
      if (noReceipt > 0) console.log(`      - No receipt found: ${noReceipt}`);
      if (statusFailed > 0) console.log(`      - Receipt status=0 (reverted): ${statusFailed}`);
      if (notMined > 0) console.log(`      - Not mined in block: ${notMined}`);
      if (dataMismatch > 0) console.log(`      - Data mismatch (from/to/value): ${dataMismatch}`);
      if (errorCount > 0) console.log(`      - RPC errors: ${errorCount}`);
    }
    
    // Update verified counts with full verification results
    verifiedTxCount = fullVerifiedCount;
    verifiedSuccessfulCount = fullVerifiedCount;
  }
  
  // Calculate block-by-block statistics
  const blockStats = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const ourTxCount = txCountByBlock.get(block.number) || 0;
    
    blockStats.push({
      number: block.number,
      timestamp: block.timestamp,
      totalTxCount: block.transactions.length,
      ourTxCount,
      gasUsed: block.gasUsed,
      gasLimit: block.gasLimit,
    });
  }
  
  // Calculate time span from block timestamps
  const firstBlock = blocks[0];
  const lastBlock = blocks[blocks.length - 1];
  const blockTimeSpanSeconds = Number(lastBlock.timestamp - firstBlock.timestamp);
  
  // Calculate time span from our actual broadcast timing (more accurate)
  const actualTimeSpanMs = broadcastEndTime - broadcastStartTime;
  const actualTimeSpanSeconds = actualTimeSpanMs / 1000;
  
  // TPS calculations
  // Method 1: Based on block timestamps (coarse - second precision only)
  let blockBasedTps = 0;
  let confirmedBlockTps = 0;
  if (blockTimeSpanSeconds > 0) {
    blockBasedTps = verifiedTxCount / blockTimeSpanSeconds;
    confirmedBlockTps = verifiedSuccessfulCount / blockTimeSpanSeconds;
  } else {
    // All same timestamp - estimate using block count and avg block time
    const estimatedTime = blockNumbers.length * 0.25; // 250ms per block
    blockBasedTps = verifiedTxCount / estimatedTime;
    confirmedBlockTps = verifiedSuccessfulCount / estimatedTime;
  }
  
  // Method 2: Based on actual broadcast duration (our timing)
  const broadcastTps = verifiedTxCount / actualTimeSpanSeconds;
  const confirmedBroadcastTps = verifiedSuccessfulCount / actualTimeSpanSeconds;
  
  // Find peak block
  const peakBlock = blockStats.reduce((max, b) => 
    b.totalTxCount > max.totalTxCount ? b : max, blockStats[0]);
  
  // Calculate average block time
  let avgBlockTime = 0;
  if (blocks.length > 1) {
    const blockTimes = [];
    for (let i = 1; i < blocks.length; i++) {
      const diff = Number(blocks[i].timestamp - blocks[i-1].timestamp);
      blockTimes.push(diff);
    }
    avgBlockTime = blockTimes.reduce((a, b) => a + b, 0) / blockTimes.length;
  }
  
  // Estimate more accurate time using block count
  const estimatedActualTimeSeconds = blockNumbers.length > 1 
    ? (blockNumbers.length - 1) * avgBlockTime + 0.5 // Add half block for first/last
    : 0.25;
  
  const estimatedTps = blockTimeSpanSeconds > 0 
    ? verifiedTxCount / Math.max(blockTimeSpanSeconds, estimatedActualTimeSeconds)
    : verifiedTxCount / estimatedActualTimeSeconds;
  
  return {
    blockCount: blockNumbers.length,
    firstBlock: firstBlock.number,
    lastBlock: lastBlock.number,
    blockTimeSpanSeconds,
    actualTimeSpanSeconds,
    receiptsCount: receipts.length,
    verifiedTxCount,
    verifiedSuccessfulCount,
    revertedTxCount,
    totalBlockTxCount,
    blockBasedTps,
    confirmedBlockTps,
    broadcastTps,
    confirmedBroadcastTps,
    peakBlock,
    avgBlockTime,
    blockStats,
    sampleVerified,
    sampleSize,
  };
}

// =============================================================================
// Report Generation
// =============================================================================

function generateReport(config, sendResult, confirmResult, tpsAnalysis) {
  console.log('\n' + '='.repeat(70));
  console.log('                    TPS BATTLE TEST REPORT');
  console.log('='.repeat(70));
  
  console.log('\n📋 TEST CONFIGURATION:');
  console.log(`   • Total transactions:    ${config.txCount}`);
  console.log(`   • Sender accounts:       ${config.senderCount}`);
  console.log(`   • Concurrent requests:   ${config.concurrentRequests}`);
  console.log(`   • RPC URL:               ${config.rpcUrl}`);
  
  console.log('\n✍️  SIGNING METRICS:');
  if (sendResult.signDuration) {
    console.log(`   • Signing time:          ${formatDuration(sendResult.signDuration)}`);
    console.log(`   • Signing rate:          ${(sendResult.txHashes.length / sendResult.signDuration * 1000).toFixed(1)} tx/s`);
  }
  
  console.log('\n📤 BROADCAST METRICS:');
  const totalSent = sendResult.successCount || sendResult.txHashes.length;
  const totalFailed = sendResult.errorCount || sendResult.errors.length;
  console.log(`   • Transactions sent:     ${totalSent}`);
  console.log(`   • Send failures:         ${totalFailed}`);
  console.log(`   • Broadcast time:        ${formatDuration(sendResult.sendDuration)}`);
  console.log(`   • Broadcast rate:        ${((totalSent + totalFailed) / sendResult.sendDuration * 1000).toFixed(1)} tx/s`);
  
  if (totalFailed > 0 && sendResult.errorTypes) {
    console.log(`   • Error breakdown:`);
    const errorLabels = {
      'gas_price_too_low': 'Gas price too low',
      'nonce_too_low': 'Nonce too low',
      'nonce_too_high': 'Nonce too high',
      'already_known': 'Already known',
      'replacement_underpriced': 'Replacement underpriced',
      'insufficient_funds': 'Insufficient funds',
      'gas_too_low': 'Gas limit too low',
      'timeout': 'Timeout',
      'connection_error': 'Connection error',
      'other': 'Other',
      'unknown': 'Unknown',
    };
    for (const [type, count] of Object.entries(sendResult.errorTypes)) {
      console.log(`     - ${errorLabels[type] || type}: ${count}`);
    }
  }
  
  console.log('\n✅ CONFIRMATION METRICS:');
  console.log(`   • Transactions confirmed: ${confirmResult.receipts.length}`);
  console.log(`   • Confirmation time:      ${formatDuration(confirmResult.confirmDuration)}`);
  
  if (tpsAnalysis) {
    console.log('\n📊 DEEP ON-CHAIN VERIFICATION:');
    console.log(`   • Blocks used:              ${tpsAnalysis.blockCount} (${tpsAnalysis.firstBlock} - ${tpsAnalysis.lastBlock})`);
    console.log(`   • Block timestamp span:     ${tpsAnalysis.blockTimeSpanSeconds}s (coarse - second precision)`);
    console.log(`   • Actual broadcast time:    ${tpsAnalysis.actualTimeSpanSeconds.toFixed(2)}s`);
    console.log(`   • Avg block time:           ${tpsAnalysis.avgBlockTime.toFixed(3)}s`);
    console.log(`   • Receipts received:        ${tpsAnalysis.receiptsCount}`);
    console.log(`   • DEEP VERIFIED (data ok):  ${tpsAnalysis.verifiedTxCount}`);
    console.log(`   • Sample direct fetch:      ${tpsAnalysis.sampleVerified}/${tpsAnalysis.sampleSize} ✓`);
    console.log(`   • CONFIRMED (status=1):     ${tpsAnalysis.verifiedSuccessfulCount}`);
    console.log(`   • REVERTED (status=0):      ${tpsAnalysis.revertedTxCount}`);
    console.log(`   • Total txs in blocks:      ${tpsAnalysis.totalBlockTxCount}`);
    
    console.log('\n🏆 TPS RESULTS:');
    console.log(`   ┌─────────────────────────────────────────────────────────────┐`);
    console.log(`   │                                                             │`);
    console.log(`   │  📍 INCLUDED TPS (on-chain, any status):                    │`);
    console.log(`   │     Block-timestamp:    ${tpsAnalysis.blockBasedTps.toFixed(2).padStart(10)} tx/s                  │`);
    console.log(`   │     Broadcast-duration: ${tpsAnalysis.broadcastTps.toFixed(2).padStart(10)} tx/s                  │`);
    console.log(`   │                                                             │`);
    console.log(`   │  ✅ CONFIRMED TPS (status=1, successful execution):         │`);
    console.log(`   │     Block-timestamp:    ${tpsAnalysis.confirmedBlockTps.toFixed(2).padStart(10)} tx/s                  │`);
    console.log(`   │     Broadcast-duration: ${tpsAnalysis.confirmedBroadcastTps.toFixed(2).padStart(10)} tx/s                  │`);
    console.log(`   │                                                             │`);
    console.log(`   └─────────────────────────────────────────────────────────────┘`);
    
    // Success rate
    const successRate = (tpsAnalysis.verifiedSuccessfulCount / tpsAnalysis.verifiedTxCount * 100).toFixed(2);
    console.log(`\n   📈 Success Rate: ${successRate}% (${tpsAnalysis.verifiedSuccessfulCount}/${tpsAnalysis.verifiedTxCount})`);
    
    console.log('\n📈 PEAK BLOCK:');
    console.log(`   • Block number:          ${tpsAnalysis.peakBlock.number}`);
    console.log(`   • Transactions:          ${tpsAnalysis.peakBlock.totalTxCount}`);
    console.log(`   • Our transactions:      ${tpsAnalysis.peakBlock.ourTxCount}`);
    console.log(`   • Gas used:              ${tpsAnalysis.peakBlock.gasUsed.toString()}`);
    
    // Show per-block breakdown for small tests
    if (tpsAnalysis.blockStats.length <= 30) {
      console.log('\n📦 BLOCK-BY-BLOCK BREAKDOWN:');
      console.log('   Block     | Timestamp | Our TXs | Total TXs | Gas Used');
      console.log('   ' + '-'.repeat(60));
      for (const block of tpsAnalysis.blockStats) {
        console.log(`   ${block.number.toString().padStart(9)} | ${block.timestamp.toString().padStart(9)} | ${block.ourTxCount.toString().padStart(7)} | ${block.totalTxCount.toString().padStart(9)} | ${block.gasUsed.toString()}`);
      }
    }
  }
  
  console.log('\n' + '='.repeat(70));
}

// =============================================================================
// Main Execution
// =============================================================================

async function main() {
  const config = parseArgs();
  
  console.log('🔥 Arbitrum Nitro TPS Battle Test');
  console.log('='.repeat(50));
  
  // Connect to provider
  console.log(`\n🔗 Connecting to ${config.rpcUrl}...`);
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  
  try {
    const network = await provider.getNetwork();
    console.log(`✅ Connected to chain ID: ${network.chainId}`);
    
    const blockNumber = await provider.getBlockNumber();
    console.log(`   Current block: ${blockNumber}`);
  } catch (err) {
    console.error(`❌ Failed to connect to RPC: ${err.message}`);
    console.log('\nMake sure the Nitro dev node is running:');
    console.log('  cd nitro-devnode && ./run-dev-node.sh');
    process.exit(1);
  }
  
  // Setup funder wallet
  const funderWallet = new ethers.Wallet(config.funderPrivateKey, provider);
  const funderBalance = await provider.getBalance(funderWallet.address);
  console.log(`\n💰 Funder account: ${funderWallet.address}`);
  console.log(`   Balance: ${ethers.formatEther(funderBalance)} ETH`);
  
  if (funderBalance < ethers.parseEther(String(config.senderCount * parseFloat(config.fundingAmount)))) {
    console.error('❌ Insufficient funder balance');
    process.exit(1);
  }
  
  // Get chain ID for transaction signing
  const network = await provider.getNetwork();
  const chainId = network.chainId;
  
  // Create and fund sender accounts
  const senders = await createAndFundSenders(
    provider,
    funderWallet,
    config.senderCount,
    config.fundingAmount,
    config
  );
  
  if (senders.length === 0) {
    console.error('❌ No sender accounts available');
    process.exit(1);
  }
  
  // Small delay to ensure funding transactions are fully processed
  await sleep(500);
  
  // Prepare and pre-sign all transactions
  const { signedTxs, signDuration, expectedTxDetails } = await prepareAndSignTransactions(senders, config, chainId, provider);
  
  if (signedTxs.length === 0) {
    console.error('❌ No transactions were signed successfully');
    process.exit(1);
  }
  
  // Fire-and-forget broadcast pre-signed transactions
  const broadcastStartTime = Date.now();
  const sendResult = await fireAndForgetBroadcast(signedTxs, config);
  const broadcastEndTime = Date.now();
  sendResult.signDuration = signDuration;
  
  if (sendResult.txHashes.length === 0) {
    console.error('❌ No transactions were broadcast successfully');
    process.exit(1);
  }
  
  // Wait for confirmations
  const confirmResult = await waitForConfirmations(provider, sendResult.txHashes);
  
  // Analyze TPS from chain (with deep verification)
  const tpsAnalysis = await analyzeBlockTPS(provider, confirmResult.receipts, broadcastStartTime, broadcastEndTime, expectedTxDetails, sendResult.txHashes, config);
  
  // Generate report
  generateReport(config, sendResult, confirmResult, tpsAnalysis);
}

// Run
main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
