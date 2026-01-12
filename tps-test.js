import { ethers } from 'ethers';
import * as readline from 'readline';
import { generatePayload, signTransactions, parseTxMix, getRequiredContracts, calculateFundingNeeds, ERC20_ABI, ROUTER_ABI } from './payload-generator.js';
import { deployToken } from './deploy-token.js';
import { deployUniswap } from './deploy-uniswap.js';
import * as ui from './terminal-ui.js';

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
  txValue: '0.00000001',  // ETH value per ETH transfer (10 gwei = 0.00000001 ETH)
  fundingAmount: '0.01',  // ETH to fund each sender account (enough for many tiny txs)
  
  // Token/Swap specific values
  tokenTxValue: '100',    // Tokens per token transfer
  swapValue: '0.0001',    // ETH per swap
  
  // Gas settings
  gasLimit: 21000,        // Standard ETH transfer gas
  
  // Timing - for fire-and-forget, these control concurrency
  concurrentRequests: 200, // Max concurrent HTTP requests
  
  // Gas buffer multiplier (to handle base fee increases during test)
  gasMultiplier: 2,       // 2x = safe for most tests, increase for long tests
  
  // Transaction mix (percentages for eth:token:swap)
  // Format: "eth:token:swap" e.g., "50:30:20" or "100:0:0" (default)
  txMix: { ethTransfer: 100, tokenTransfer: 0, swap: 0 },
  
  // Verification
  verifyAll: false,       // If true, fetch and verify EVERY transaction individually
  
  // Contract addresses (filled during setup if needed)
  contracts: {
    token: null,
    weth: null,
    router: null,
    factory: null,
    pair: null,
  },
};

// =============================================================================
// Parse CLI Arguments
// =============================================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { ...CONFIG, contracts: { ...CONFIG.contracts } };
  
  // Check if interactive mode requested or no args
  if (args.length === 0 || args.includes('--interactive') || args.includes('-i')) {
    config.interactive = true;
    return config;
  }
  
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
    if (key === 'tokenTxValue') config.tokenTxValue = value;
    if (key === 'swapValue') config.swapValue = value;
    
    // Transaction mix: --txMix=50:30:20 (eth:token:swap)
    if (key === 'txMix') {
      config.txMix = parseTxMix(value);
    }
    
    // Pre-deployed contract addresses (optional, skip deployment)
    if (key === 'token') config.contracts.token = value;
    if (key === 'weth') config.contracts.weth = value;
    if (key === 'router') config.contracts.router = value;
  }
  
  return config;
}

// =============================================================================
// Interactive Input Mode
// =============================================================================

function prompt(rl, question, defaultValue) {
  return new Promise((resolve) => {
    const defaultStr = defaultValue !== undefined ? ` (${defaultValue})` : '';
    rl.question(`${question}${defaultStr}: `, (answer) => {
      resolve(answer.trim() || String(defaultValue));
    });
  });
}

async function interactiveConfig(config) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  
  ui.printSection('Configuration', '⚙️');
  console.log(`${ui.colors.dim}Press Enter to use default values shown in parentheses.${ui.colors.reset}\n`);
  
  try {
    // Transaction count
    const txCount = await prompt(rl, '📊 Total transactions to send', config.txCount);
    config.txCount = parseInt(txCount) || config.txCount;
    
    // Sender count
    const senderCount = await prompt(rl, '👥 Number of sender wallets', config.senderCount);
    config.senderCount = parseInt(senderCount) || config.senderCount;
    
    // Concurrent requests
    const concurrent = await prompt(rl, '⚡ Concurrent HTTP requests', config.concurrentRequests);
    config.concurrentRequests = parseInt(concurrent) || config.concurrentRequests;
    
    // Transaction mix - smart input
    console.log('\n📦 Transaction Mix (must sum to 100%)');
    const ethPercent = await prompt(rl, '   ETH transfer %', config.txMix.ethTransfer);
    const eth = parseInt(ethPercent) || 0;
    
    let token = 0;
    let swap = 0;
    
    if (eth < 100) {
      const remaining = 100 - eth;
      const tokenPercent = await prompt(rl, `   Token transfer % (remaining: ${remaining})`, Math.min(config.txMix.tokenTransfer, remaining));
      token = Math.min(parseInt(tokenPercent) || 0, remaining);
      
      swap = 100 - eth - token;
      if (swap > 0) {
        console.log(`   Swap %: ${swap} (auto-calculated)`);
      }
    } else {
      console.log('   100% ETH transfers - skipping token/swap options');
    }
    
    config.txMix = {
      ethTransfer: eth,
      tokenTransfer: token,
      swap: swap,
    };
    
    // Verify all
    const verifyAll = await prompt(rl, '\n🔍 Verify all transactions individually? (yes/no)', config.verifyAll ? 'yes' : 'no');
    config.verifyAll = verifyAll.toLowerCase() === 'yes' || verifyAll.toLowerCase() === 'y';
    
    // Summary box
    const summaryContent = 
      `  Transactions:  ${ui.style.value(config.txCount)}\n` +
      `  Senders:       ${ui.style.value(config.senderCount)}\n` +
      `  Concurrent:    ${ui.style.value(config.concurrentRequests)}\n` +
      `  Mix:           ${ui.style.value(`${config.txMix.ethTransfer}% ETH`)} │ ${ui.style.value(`${config.txMix.tokenTransfer}% Token`)} │ ${ui.style.value(`${config.txMix.swap}% Swap`)}\n` +
      `  Verify all:    ${config.verifyAll ? ui.style.success('Yes') : ui.style.dim('No')}`;
    
    console.log('\n' + ui.drawBox('Configuration Summary', summaryContent));
    
    const confirm = await prompt(rl, `\n${ui.colors.brightGreen}▶${ui.colors.reset} Start test? (yes/no)`, 'yes');
    
    if (confirm.toLowerCase() !== 'yes' && confirm.toLowerCase() !== 'y') {
      ui.error('Test cancelled.');
      process.exit(0);
    }
    
  } finally {
    rl.close();
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
// Contract Deployment (Token + Uniswap if needed)
// =============================================================================

async function setupContracts(config, provider, funderWallet) {
  const { needsToken, needsUniswap } = getRequiredContracts(config.txMix);
  
  if (!needsToken && !needsUniswap) {
    console.log('\n📦 No contracts needed for ETH-only transfers');
    return config.contracts;
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('📦 CONTRACT SETUP PHASE');
  console.log('='.repeat(60));
  console.log(`   Needs Token: ${needsToken}`);
  console.log(`   Needs Uniswap: ${needsUniswap}`);
  
  const contracts = { ...config.contracts };
  
  // Check if contracts are already provided
  if (contracts.token && (!needsUniswap || (contracts.weth && contracts.router))) {
    console.log('\n✅ Using pre-deployed contracts:');
    console.log(`   Token: ${contracts.token}`);
    if (needsUniswap) {
      console.log(`   WETH: ${contracts.weth}`);
      console.log(`   Router: ${contracts.router}`);
    }
    return contracts;
  }
  
  // Deploy Token if needed
  if (needsToken && !contracts.token) {
    console.log('\n🪙 Deploying Test Token...');
    
    const tokenResult = await deployToken({
      rpcUrl: config.rpcUrl,
      deployerPrivateKey: config.funderPrivateKey,
      tokenName: 'TPS Test Token',
      tokenSymbol: 'TPSTEST',
      tokenDecimals: 18,
      initialSupply: '10000000000', // 10 billion tokens
    });
    
    contracts.token = tokenResult.contractAddress;
    console.log(`✅ Token deployed: ${contracts.token}`);
  }
  
  // Deploy Uniswap if needed
  if (needsUniswap && !contracts.router) {
    console.log('\n🦄 Deploying Uniswap V2...');
    
    const uniswapResult = await deployUniswap({
      rpcUrl: config.rpcUrl,
      deployerPrivateKey: config.funderPrivateKey,
    });
    
    contracts.weth = uniswapResult.weth.address;
    contracts.factory = uniswapResult.factory.address;
    contracts.router = uniswapResult.router.address;
    
    console.log(`✅ WETH: ${contracts.weth}`);
    console.log(`✅ Factory: ${contracts.factory}`);
    console.log(`✅ Router: ${contracts.router}`);
    
    // Create liquidity pool
    console.log('\n💧 Creating Token/ETH liquidity pool...');
    
    const token = new ethers.Contract(contracts.token, ERC20_ABI, funderWallet);
    const router = new ethers.Contract(contracts.router, ROUTER_ABI, funderWallet);
    
    // Approve router for initial liquidity
    const liquidityTokenAmount = ethers.parseUnits('1000000000', 18); // 1B tokens
    const liquidityEthAmount = ethers.parseEther('100'); // 100 ETH (makes token cheap)
    
    let nonce = await funderWallet.getNonce();
    
    const approveTx = await token.approve(contracts.router, liquidityTokenAmount, { nonce: nonce++ });
    await approveTx.wait();
    console.log(`   Approved router to spend tokens`);
    
    // Add liquidity
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const addLiqTx = await router.addLiquidityETH(
      contracts.token,
      liquidityTokenAmount,
      liquidityTokenAmount,
      liquidityEthAmount,
      funderWallet.address,
      deadline,
      { value: liquidityEthAmount, nonce: nonce++, gasLimit: 5000000 }
    );
    await addLiqTx.wait();
    
    // Get pair address
    const factoryAbi = ['function getPair(address, address) view returns (address)'];
    const factory = new ethers.Contract(contracts.factory, factoryAbi, provider);
    contracts.pair = await factory.getPair(contracts.token, contracts.weth);
    
    console.log(`✅ Liquidity added! Pair: ${contracts.pair}`);
    console.log(`   Price: 1 ETH = ${Number(liquidityTokenAmount) / Number(liquidityEthAmount) / 1e18 * 1e18} tokens`);
  }
  
  console.log('\n' + '='.repeat(60));
  
  return contracts;
}

// =============================================================================
// Account Management
// =============================================================================

async function createAndFundSenders(provider, funderWallet, count, config, contracts) {
  console.log(`\n📦 Creating ${count} sender accounts...`);
  
  const senders = [];
  
  // Create wallets
  for (let i = 0; i < count; i++) {
    const wallet = ethers.Wallet.createRandom().connect(provider);
    senders.push(wallet);
  }
  
  console.log(`✅ Created ${count} wallets`);
  
  // Calculate funding needs based on tx mix
  const fundingNeeds = calculateFundingNeeds(config, count);
  const ethFunding = fundingNeeds.ethPerSender;
  const tokenFunding = fundingNeeds.tokensPerSender;
  
  console.log(`\n💸 Funding ${count} sender accounts...`);
  console.log(`   ETH per sender: ${ethers.formatEther(ethFunding)} ETH`);
  
  if (config.txMix.tokenTransfer > 0) {
    console.log(`   Tokens per sender: ${ethers.formatUnits(tokenFunding, 18)} tokens`);
  }
  
  // Get funder's nonce and fee data with buffer
  let nonce = await funderWallet.getNonce();
  const feeData = await provider.getFeeData();
  const chainId = (await provider.getNetwork()).chainId;
  
  // Use gas multiplier for funding too
  const multiplier = BigInt(Math.floor((config.gasMultiplier || 2) * 100));
  const maxFeePerGas = (feeData.maxFeePerGas || feeData.gasPrice) * multiplier / 100n;
  
  // Pre-sign all ETH funding transactions
  console.log(`   Pre-signing ${count} ETH funding transactions...`);
  const fundingTxs = [];
  const txHashes = [];
  
  for (let i = 0; i < senders.length; i++) {
    const tx = {
      to: senders[i].address,
      value: ethFunding,
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
  
  // Broadcast ETH funding transactions
  console.log(`   Broadcasting ${count} ETH funding transactions...`);
  let broadcastSuccess = 0;
  let broadcastFailed = 0;
  
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
    
    process.stdout.write(`\r   ETH Broadcast: ${i + batch.length}/${count} (✓${broadcastSuccess} ✗${broadcastFailed})`);
  }
  console.log();
  
  if (broadcastSuccess === 0) {
    console.log(`❌ All ETH funding transactions failed to broadcast`);
    return [];
  }
  
  // Wait for ETH funding to confirm
  console.log(`   Waiting for ETH funding to confirm...`);
  const startWait = Date.now();
  const timeout = Math.max(30000, count * 10);
  
  let funded = 0;
  let lastFunded = 0;
  let stableCount = 0;
  
  while (Date.now() - startWait < timeout) {
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
    
    if (funded >= broadcastSuccess) break;
    
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
  
  // Filter funded senders
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
  
  console.log(`✅ ETH funded ${fundedSenders.length}/${count} sender accounts`);
  
  // Distribute tokens if needed
  if (config.txMix.tokenTransfer > 0 && contracts.token && fundedSenders.length > 0) {
    console.log(`\n🪙 Distributing tokens to senders...`);
    
    const token = new ethers.Contract(contracts.token, ERC20_ABI, funderWallet);
    nonce = await funderWallet.getNonce();
    
    // Pre-sign token transfers
    const tokenTxs = [];
    const iface = new ethers.Interface(ERC20_ABI);
    
    for (let i = 0; i < fundedSenders.length; i++) {
      const data = iface.encodeFunctionData('transfer', [fundedSenders[i].address, tokenFunding]);
      const tx = {
        to: contracts.token,
        value: 0n,
        data: data,
        nonce: nonce++,
        gasLimit: 100000n,
        chainId: chainId,
        type: 2,
        maxFeePerGas: maxFeePerGas,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || 0n,
      };
      
      const signedTx = await funderWallet.signTransaction(tx);
      tokenTxs.push({ signedTx, senderIdx: i });
    }
    
    // Broadcast token transfers
    let tokenSuccess = 0;
    for (let i = 0; i < tokenTxs.length; i += batchSize) {
      const batch = tokenTxs.slice(i, i + batchSize);
      
      const batchPromises = batch.map(async ({ signedTx }) => {
        try {
          const response = await fetch(config.rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              method: 'eth_sendRawTransaction',
              params: [signedTx],
              id: 1,
            }),
          });
          const result = await response.json();
          return result.result ? true : false;
        } catch {
          return false;
        }
      });
      
      const results = await Promise.all(batchPromises);
      tokenSuccess += results.filter(r => r).length;
      
      process.stdout.write(`\r   Token distribution: ${i + batch.length}/${fundedSenders.length}`);
    }
    console.log();
    
    // Wait for token transfers
    await sleep(2000);
    console.log(`✅ Token distribution sent (${tokenSuccess} txs)`);
  }
  
  // Approve router for swaps if needed
  if (config.txMix.swap > 0 && contracts.router && fundedSenders.length > 0) {
    console.log(`\n🔓 Approving router for all senders (for token->ETH swaps)...`);
    
    const iface = new ethers.Interface(ERC20_ABI);
    const approvalAmount = ethers.MaxUint256;
    
    // Each sender approves the router
    let approvalSuccess = 0;
    const approvalBatchSize = 50;
    
    for (let i = 0; i < fundedSenders.length; i += approvalBatchSize) {
      const batch = fundedSenders.slice(i, i + approvalBatchSize);
      
      const approvalPromises = batch.map(async (sender) => {
        try {
          const senderNonce = await sender.getNonce();
          const data = iface.encodeFunctionData('approve', [contracts.router, approvalAmount]);
          
          const tx = {
            to: contracts.token,
            value: 0n,
            data: data,
            nonce: senderNonce,
            gasLimit: 100000n,
            chainId: chainId,
            type: 2,
            maxFeePerGas: maxFeePerGas,
            maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || 0n,
          };
          
          const signedTx = await sender.signTransaction(tx);
          
          const response = await fetch(config.rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              method: 'eth_sendRawTransaction',
              params: [signedTx],
              id: 1,
            }),
          });
          const result = await response.json();
          return result.result ? true : false;
        } catch {
          return false;
        }
      });
      
      const results = await Promise.all(approvalPromises);
      approvalSuccess += results.filter(r => r).length;
      
      process.stdout.write(`\r   Approvals: ${i + batch.length}/${fundedSenders.length}`);
    }
    console.log();
    
    // Wait for approvals to confirm
    await sleep(2000);
    console.log(`✅ Router approvals sent (${approvalSuccess} txs)`);
  }
  
  if (fundedSenders.length < count) {
    console.log(`   ⚠️  ${count - fundedSenders.length} accounts not funded (will use ${fundedSenders.length} senders)`);
  }
  
  return fundedSenders;
}

// =============================================================================
// Transaction Preparation & Pre-signing (using payload-generator module)
// =============================================================================

async function prepareAndSignTransactions(senders, config, chainId, provider, contracts) {
  // Generate payload using the payload generator module
  const { unsignedTxs, expectedTxDetails } = await generatePayload({
    senders,
    provider,
    chainId,
    config,
    contracts,
  });
  
  // Sign transactions using the payload generator module
  const { signedTxs, signDuration } = await signTransactions(unsignedTxs, formatDuration);
  
  return { signedTxs, signDuration, expectedTxDetails };
}

// =============================================================================
// Memory-Efficient Parallel Broadcaster
// =============================================================================

async function fireAndForgetBroadcast(signedTxs, config) {
  console.log(`\n🚀 Broadcasting ${signedTxs.length} transactions...`);
  console.log(`   Concurrency: ${config.concurrentRequests} parallel requests`);
  console.log(`   Mix: ${config.txMix.ethTransfer}% ETH | ${config.txMix.tokenTransfer}% Token | ${config.txMix.swap}% Swap`);
  
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
    if (msg.includes('execution reverted')) return 'execution_reverted';
    return 'other';
  };
  
  // Create a pool of workers
  const worker = async () => {
    while (nextIndex < signedTxs.length) {
      const idx = nextIndex++;
      const { signedTx, index, expectedFrom, txType } = signedTxs[idx];
      
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
          successCount++;
          txHashes.push({ hash: result.result, index, expectedFrom, txType });
        } else {
          errorCount++;
          const errorMsg = result.error?.message || 'Unknown error';
          const errorType = categorizeError(errorMsg);
          errorTypes.set(errorType, (errorTypes.get(errorType) || 0) + 1);
          
          if (!errorExamples.has(errorType)) {
            errorExamples.set(errorType, errorMsg);
          }
          
          if (!firstError) firstError = errorMsg;
        }
      } catch (err) {
        errorCount++;
        const errorType = categorizeError(err.message);
        errorTypes.set(errorType, (errorTypes.get(errorType) || 0) + 1);
        
        if (!firstError) firstError = err.message;
      }
      
      // Progress update
      const total = successCount + errorCount;
      if (total % 100 === 0 || total === signedTxs.length) {
        const elapsed = Date.now() - startTime;
        const rate = (total / elapsed) * 1000;
        process.stdout.write(`\r   Progress: ${total}/${signedTxs.length} (✓${successCount} ✗${errorCount}) ${rate.toFixed(0)} tx/s`);
      }
    }
  };
  
  // Start workers
  const workers = [];
  for (let i = 0; i < config.concurrentRequests; i++) {
    workers.push(worker());
  }
  
  // Wait for all workers to complete
  await Promise.all(workers);
  
  const endTime = Date.now();
  const totalTime = endTime - startTime;
  
  console.log(`\n✅ Broadcast complete in ${formatDuration(totalTime)}`);
  console.log(`   Success: ${successCount}, Failed: ${errorCount}`);
  
  if (firstError) {
    console.log(`   First error: ${firstError.substring(0, 100)}...`);
  }
  
  // Convert errorTypes Map to object for return
  const errorTypesObj = {};
  for (const [type, count] of errorTypes) {
    errorTypesObj[type] = count;
  }
  
  return {
    txHashes,
    successCount,
    errorCount,
    firstError,
    broadcastDuration: totalTime,
    errorTypes: errorTypesObj,
  };
}

// =============================================================================
// Confirmation Tracking
// =============================================================================

async function waitForConfirmations(provider, txHashes, timeoutMs = 60000) {
  console.log(`\n⏳ Waiting for ${txHashes.length} transactions to confirm...`);
  
  const startTime = Date.now();
  const receipts = [];
  const pending = new Set(txHashes.map(t => t.hash));
  
  while (pending.size > 0 && Date.now() - startTime < timeoutMs) {
    const checkBatch = Array.from(pending).slice(0, 100);
    
    const receiptPromises = checkBatch.map(async (hash) => {
      try {
        const receipt = await provider.getTransactionReceipt(hash);
        if (receipt) {
          pending.delete(hash);
          return receipt;
        }
      } catch {
        // Ignore errors, will retry
      }
      return null;
    });
    
    const batchReceipts = await Promise.all(receiptPromises);
    
    for (const receipt of batchReceipts) {
      if (receipt) receipts.push(receipt);
    }
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    process.stdout.write(`\r   Confirmed: ${receipts.length}/${txHashes.length} (${elapsed}s)`);
    
    if (pending.size > 0) {
      await sleep(500);
    }
  }
  
  const confirmDuration = Date.now() - startTime;
  console.log(`\n✅ Confirmed ${receipts.length}/${txHashes.length} in ${formatDuration(confirmDuration)}`);
  
  return { receipts, confirmDuration };
}

// =============================================================================
// TPS Analysis (Block-based)
// =============================================================================

async function analyzeBlockTPS(provider, receipts, broadcastStartTime, broadcastEndTime, expectedTxDetails, txHashesWithMeta, config) {
  if (receipts.length === 0) {
    console.log('⚠️  No receipts to analyze');
    return null;
  }
  
  console.log(`\n📊 Analyzing on-chain TPS...`);
  
  // Find block range from receipts
  const blockNumbers = [...new Set(receipts.map(r => r.blockNumber))].sort((a, b) => a - b);
  const firstBlock = Math.min(...blockNumbers);
  const lastBlock = Math.max(...blockNumbers);
  
  console.log(`   Block range: ${firstBlock} - ${lastBlock} (${blockNumbers.length} blocks)`);
  
  // Fetch blocks (without full transaction data to avoid "response too large")
  const blockPromises = [];
  for (let i = firstBlock; i <= lastBlock; i++) {
    blockPromises.push(provider.getBlock(i, false));
  }
  const blocks = await Promise.all(blockPromises);
  
  // Build transaction hash to metadata map
  const txHashToMeta = new Map();
  for (const { hash, index, expectedFrom, txType } of txHashesWithMeta) {
    txHashToMeta.set(hash.toLowerCase(), { index, expectedFrom, txType });
  }
  
  // Analyze blocks
  const blockStats = [];
  let totalBlockTxCount = 0;
  let ourTxCount = 0;
  let verifiedTxCount = 0;
  let verifiedSuccessfulCount = 0;
  let revertedTxCount = 0;
  
  // Track tx types in verified
  const verifiedByType = { eth_transfer: 0, token_transfer: 0, swap: 0 };
  
  for (const block of blocks) {
    if (!block) continue;
    
    const txHashes = block.transactions || [];
    totalBlockTxCount += txHashes.length;
    
    let blockOurTxCount = 0;
    
    for (const hash of txHashes) {
      const hashLower = hash.toLowerCase();
      if (txHashToMeta.has(hashLower)) {
        blockOurTxCount++;
        ourTxCount++;
        
        const meta = txHashToMeta.get(hashLower);
        const receipt = receipts.find(r => r.hash.toLowerCase() === hashLower);
        
        if (receipt) {
          verifiedTxCount++;
          if (receipt.status === 1) {
            verifiedSuccessfulCount++;
            if (meta.txType) {
              verifiedByType[meta.txType] = (verifiedByType[meta.txType] || 0) + 1;
            }
          } else {
            revertedTxCount++;
          }
        }
      }
    }
    
    blockStats.push({
      number: block.number,
      timestamp: block.timestamp,
      totalTxCount: txHashes.length,
      ourTxCount: blockOurTxCount,
      gasUsed: block.gasUsed,
    });
  }
  
  // Calculate TPS metrics
  const firstBlockData = blockStats[0];
  const lastBlockData = blockStats[blockStats.length - 1];
  const blockTimeSpanSeconds = lastBlockData.timestamp - firstBlockData.timestamp || 1;
  const actualTimeSpanSeconds = (broadcastEndTime - broadcastStartTime) / 1000;
  
  // Find peak block
  const peakBlock = blockStats.reduce((max, block) => 
    block.ourTxCount > max.ourTxCount ? block : max, blockStats[0]);
  
  // TPS calculations
  const blockBasedTps = verifiedTxCount / blockTimeSpanSeconds;
  const broadcastTps = verifiedTxCount / actualTimeSpanSeconds;
  const confirmedBlockTps = verifiedSuccessfulCount / blockTimeSpanSeconds;
  const confirmedBroadcastTps = verifiedSuccessfulCount / actualTimeSpanSeconds;
  
  return {
    blockCount: blockStats.length,
    firstBlock,
    lastBlock,
    blockTimeSpanSeconds,
    actualTimeSpanSeconds,
    avgBlockTime: blockTimeSpanSeconds / Math.max(1, blockStats.length - 1),
    totalBlockTxCount,
    ourTxCount,
    verifiedTxCount,
    verifiedSuccessfulCount,
    revertedTxCount,
    receiptsCount: receipts.length,
    sampleVerified: Math.min(10, verifiedTxCount),
    sampleSize: Math.min(10, verifiedTxCount),
    blockBasedTps,
    broadcastTps,
    confirmedBlockTps,
    confirmedBroadcastTps,
    peakBlock,
    blockStats,
    verifiedByType,
  };
}

// =============================================================================
// Report Generation
// =============================================================================

function generateReport(config, sendResult, confirmResult, tpsAnalysis) {
  ui.printSection('Test Report', '📊');
  
  // Configuration
  ui.printSubSection('Configuration');
  ui.printStats({
    'Transaction count': ui.formatNumber(config.txCount),
    'Sender accounts': config.senderCount,
    'Concurrent requests': config.concurrentRequests,
    'Gas multiplier': `${config.gasMultiplier}x`,
    'Transaction mix': `${config.txMix.ethTransfer}% ETH │ ${config.txMix.tokenTransfer}% Token │ ${config.txMix.swap}% Swap`,
  });
  
  // Broadcast metrics
  ui.printSubSection('Broadcast Metrics');
  const broadcastRate = (sendResult.successCount / (sendResult.broadcastDuration / 1000)).toFixed(2);
  ui.printStats({
    'Signing time': sendResult.signDuration ? ui.formatDuration(sendResult.signDuration) : 'N/A',
    'Broadcast success': ui.style.success(sendResult.successCount),
    'Broadcast failed': sendResult.errorCount > 0 ? ui.style.error(sendResult.errorCount) : '0',
    'Broadcast time': ui.formatDuration(sendResult.broadcastDuration),
    'Broadcast rate': `${broadcastRate} tx/s`,
  });
  
  if (Object.keys(sendResult.errorTypes).length > 0) {
    console.log(`\n   ${ui.colors.dim}Error breakdown:${ui.colors.reset}`);
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
      'execution_reverted': 'Execution reverted',
      'other': 'Other',
      'unknown': 'Unknown',
    };
    for (const [type, count] of Object.entries(sendResult.errorTypes)) {
      console.log(`     ${ui.colors.dim}•${ui.colors.reset} ${errorLabels[type] || type}: ${ui.style.warning(count)}`);
    }
  }
  
  // Confirmation metrics
  ui.printSubSection('Confirmation Metrics');
  ui.printStats({
    'Transactions confirmed': ui.style.success(confirmResult.receipts.length),
    'Confirmation time': ui.formatDuration(confirmResult.confirmDuration),
  });
  
  if (tpsAnalysis) {
    // On-chain verification
    ui.printSubSection('On-Chain Verification');
    ui.printStats({
      'Blocks used': `${tpsAnalysis.blockCount} (${tpsAnalysis.firstBlock} → ${tpsAnalysis.lastBlock})`,
      'Block timestamp span': `${tpsAnalysis.blockTimeSpanSeconds}s`,
      'Actual broadcast time': `${tpsAnalysis.actualTimeSpanSeconds.toFixed(2)}s`,
      'Avg block time': `${tpsAnalysis.avgBlockTime.toFixed(3)}s`,
      'Verified on-chain': ui.style.value(tpsAnalysis.verifiedTxCount),
      'Confirmed (status=1)': ui.style.success(tpsAnalysis.verifiedSuccessfulCount),
      'Reverted (status=0)': tpsAnalysis.revertedTxCount > 0 ? ui.style.error(tpsAnalysis.revertedTxCount) : '0',
    });
    
    // Breakdown by type if mixed
    if (config.txMix.tokenTransfer > 0 || config.txMix.swap > 0) {
      console.log(`\n   ${ui.colors.dim}By transaction type:${ui.colors.reset}`);
      console.log(`     ${ui.colors.dim}•${ui.colors.reset} ETH transfers:   ${ui.style.value(tpsAnalysis.verifiedByType.eth_transfer || 0)}`);
      console.log(`     ${ui.colors.dim}•${ui.colors.reset} Token transfers: ${ui.style.value(tpsAnalysis.verifiedByType.token_transfer || 0)}`);
      console.log(`     ${ui.colors.dim}•${ui.colors.reset} Swaps:           ${ui.style.value(tpsAnalysis.verifiedByType.swap || 0)}`);
    }
    
    // TPS Results Box
    ui.printTPSResults(
      { blockTps: tpsAnalysis.blockBasedTps, broadcastTps: tpsAnalysis.broadcastTps },
      { blockTps: tpsAnalysis.confirmedBlockTps, broadcastTps: tpsAnalysis.confirmedBroadcastTps }
    );
    
    // Success rate
    const successRate = (tpsAnalysis.verifiedSuccessfulCount / tpsAnalysis.verifiedTxCount * 100).toFixed(1);
    const rateColor = successRate >= 99 ? ui.colors.brightGreen : successRate >= 90 ? ui.colors.brightYellow : ui.colors.brightRed;
    console.log(`\n   📈 Success Rate: ${rateColor}${successRate}%${ui.colors.reset} (${tpsAnalysis.verifiedSuccessfulCount}/${tpsAnalysis.verifiedTxCount})`);
    
    // Peak block
    ui.printSubSection('Peak Block');
    ui.printStats({
      'Block number': tpsAnalysis.peakBlock.number,
      'Our transactions': ui.style.value(tpsAnalysis.peakBlock.ourTxCount),
      'Total transactions': tpsAnalysis.peakBlock.totalTxCount,
    });
    
    // Block-by-block breakdown for small tests
    if (tpsAnalysis.blockStats.length <= 15) {
      console.log(`\n   ${ui.colors.dim}Block-by-block:${ui.colors.reset}`);
      ui.printTable(
        ['Block', 'Time', 'Our TXs', 'Total', 'Gas Used'],
        tpsAnalysis.blockStats.map(b => [
          b.number,
          b.timestamp,
          b.ourTxCount,
          b.totalTxCount,
          b.gasUsed.toString().slice(0, 10),
        ]),
        [10, 10, 8, 8, 12]
      );
    }
  }
  
  console.log(`\n${ui.colors.dim}${'─'.repeat(64)}${ui.colors.reset}`);
  ui.success('Test completed!');
}

// =============================================================================
// Main Execution
// =============================================================================

async function main() {
  // Print banner
  ui.printBanner();
  
  let config = parseArgs();
  
  // Interactive mode if no args or --interactive flag
  if (config.interactive) {
    config = await interactiveConfig(config);
  }
  
  console.log(`\n${ui.colors.dim}Transaction Mix:${ui.colors.reset} ${ui.style.value(`${config.txMix.ethTransfer}%`)} ETH │ ${ui.style.value(`${config.txMix.tokenTransfer}%`)} Token │ ${ui.style.value(`${config.txMix.swap}%`)} Swap`);
  
  // Connect to provider
  ui.printSection('Connection', '🔗');
  const spinner = ui.createSpinner(`Connecting to ${ui.style.dim(config.rpcUrl)}...`);
  spinner.start();
  
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  
  try {
    const network = await provider.getNetwork();
    spinner.stop(`Connected to chain ID: ${ui.style.value(network.chainId)}`, true);
    
    const blockNumber = await provider.getBlockNumber();
    ui.printKeyValue('Current block', blockNumber, 3);
  } catch (err) {
    spinner.stop(`Failed to connect: ${err.message}`, false);
    console.log(`\n${ui.colors.dim}Make sure the Nitro dev node is running:${ui.colors.reset}`);
    console.log(`  ${ui.style.highlight('cd nitro-devnode && ./run-dev-node.sh')}`);
    process.exit(1);
  }
  
  // Setup funder wallet
  const funderWallet = new ethers.Wallet(config.funderPrivateKey, provider);
  const funderBalance = await provider.getBalance(funderWallet.address);
  console.log();
  ui.printKeyValue('Funder', funderWallet.address, 3);
  ui.printKeyValue('Balance', `${ethers.formatEther(funderBalance)} ETH`, 3);
  
  // Get chain ID for transaction signing
  const network = await provider.getNetwork();
  const chainId = network.chainId;
  
  // Setup contracts if needed (Token, Uniswap)
  const contracts = await setupContracts(config, provider, funderWallet);
  config.contracts = contracts;
  
  // Create and fund sender accounts (with tokens and approvals if needed)
  const senders = await createAndFundSenders(
    provider,
    funderWallet,
    config.senderCount,
    config,
    contracts
  );
  
  if (senders.length === 0) {
    console.error('❌ No sender accounts available');
    process.exit(1);
  }
  
  // Small delay to ensure all setup transactions are fully processed
  await sleep(1000);
  
  // Prepare and pre-sign all transactions
  const { signedTxs, signDuration, expectedTxDetails } = await prepareAndSignTransactions(
    senders, config, chainId, provider, contracts
  );
  
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
  
  // Analyze TPS from chain
  const tpsAnalysis = await analyzeBlockTPS(
    provider, confirmResult.receipts, broadcastStartTime, broadcastEndTime,
    expectedTxDetails, sendResult.txHashes, config
  );
  
  // Generate report
  generateReport(config, sendResult, confirmResult, tpsAnalysis);
}

// Run
main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
