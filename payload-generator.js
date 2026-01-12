import { ethers } from 'ethers';

/**
 * Payload Generator for TPS Testing
 * 
 * Supports multiple transaction types:
 * - ETH transfers
 * - ERC20 token transfers
 * - Uniswap swaps (ETH <-> Token)
 */

// =============================================================================
// Transaction Types
// =============================================================================

export const TX_TYPES = {
  ETH_TRANSFER: 'eth_transfer',
  TOKEN_TRANSFER: 'token_transfer',
  SWAP: 'swap',
};

// Standard ERC20 ABI (minimal)
export const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

// Uniswap Router ABI (minimal)
export const ROUTER_ABI = [
  'function swapExactETHForTokens(uint amountOutMin, address[] path, address to, uint deadline) payable returns (uint[] amounts)',
  'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) returns (uint[] amounts)',
  'function getAmountsOut(uint amountIn, address[] path) view returns (uint[] amounts)',
  'function addLiquidityETH(address token, uint amountTokenDesired, uint amountTokenMin, uint amountETHMin, address to, uint deadline) payable returns (uint amountToken, uint amountETH, uint liquidity)',
];

// =============================================================================
// Parse Transaction Mix
// =============================================================================

/**
 * Parse transaction mix from string "eth:token:swap" percentages
 * @param {string} mixString - e.g., "50:30:20" or "100:0:0"
 * @returns {Object} - { ethTransfer: 50, tokenTransfer: 30, swap: 20 }
 */
export function parseTxMix(mixString) {
  if (!mixString) {
    return { ethTransfer: 100, tokenTransfer: 0, swap: 0 };
  }
  
  const parts = mixString.split(':').map(p => parseInt(p.trim()) || 0);
  const [eth = 100, token = 0, swap = 0] = parts;
  
  const total = eth + token + swap;
  if (total !== 100) {
    console.warn(`⚠️  Transaction mix doesn't sum to 100% (${total}%), normalizing...`);
  }
  
  return {
    ethTransfer: Math.round((eth / total) * 100),
    tokenTransfer: Math.round((token / total) * 100),
    swap: Math.round((swap / total) * 100),
  };
}

/**
 * Determine which contracts need to be deployed based on tx mix
 * @param {Object} txMix
 * @returns {Object} - { needsToken, needsUniswap }
 */
export function getRequiredContracts(txMix) {
  return {
    needsToken: txMix.tokenTransfer > 0 || txMix.swap > 0,
    needsUniswap: txMix.swap > 0,
  };
}

// =============================================================================
// ETH Transfer Generator
// =============================================================================

function generateEthTransferTx(sender, nonce, recipient, value, gasParams, chainId, gasLimit) {
  return {
    to: recipient,
    value: value,
    nonce: nonce,
    gasLimit: gasLimit,
    chainId: chainId,
    type: 2,
    maxFeePerGas: gasParams.maxFeePerGas,
    maxPriorityFeePerGas: gasParams.maxPriorityFeePerGas,
  };
}

// =============================================================================
// Token Transfer Generator
// =============================================================================

function generateTokenTransferTx(sender, nonce, tokenAddress, recipient, amount, gasParams, chainId) {
  const iface = new ethers.Interface(ERC20_ABI);
  const data = iface.encodeFunctionData('transfer', [recipient, amount]);
  
  return {
    to: tokenAddress,
    value: 0n,
    data: data,
    nonce: nonce,
    gasLimit: 100000n, // Token transfers need more gas
    chainId: chainId,
    type: 2,
    maxFeePerGas: gasParams.maxFeePerGas,
    maxPriorityFeePerGas: gasParams.maxPriorityFeePerGas,
  };
}

// =============================================================================
// Swap Generator
// =============================================================================

function generateSwapTx(sender, nonce, routerAddress, wethAddress, tokenAddress, ethAmount, gasParams, chainId) {
  const iface = new ethers.Interface(ROUTER_ABI);
  const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour
  const path = [wethAddress, tokenAddress];
  
  const data = iface.encodeFunctionData('swapExactETHForTokens', [
    0n, // amountOutMin - accept any amount for stress testing
    path,
    sender.address,
    deadline,
  ]);
  
  return {
    to: routerAddress,
    value: ethAmount,
    data: data,
    nonce: nonce,
    gasLimit: 200000n, // Swaps need more gas
    chainId: chainId,
    type: 2,
    maxFeePerGas: gasParams.maxFeePerGas,
    maxPriorityFeePerGas: gasParams.maxPriorityFeePerGas,
  };
}

// =============================================================================
// Mixed Payload Generator
// =============================================================================

/**
 * Generate mixed transaction payloads
 * @param {Object} options
 * @param {Array} options.senders - Array of wallet objects
 * @param {Object} options.provider - Ethers provider
 * @param {bigint} options.chainId - Chain ID
 * @param {Object} options.config - Configuration object
 * @param {Object} options.contracts - Deployed contract addresses (if needed)
 * @returns {Promise<Object>}
 */
export async function generatePayload(options) {
  const { senders, provider, chainId, config, contracts = {} } = options;
  const txMix = config.txMix || { ethTransfer: 100, tokenTransfer: 0, swap: 0 };
  
  console.log(`\n🔧 Generating ${config.txCount} transactions...`);
  console.log(`   Mix: ${txMix.ethTransfer}% ETH | ${txMix.tokenTransfer}% Token | ${txMix.swap}% Swap`);
  
  // Calculate counts for each type
  const ethCount = Math.floor(config.txCount * txMix.ethTransfer / 100);
  const tokenCount = Math.floor(config.txCount * txMix.tokenTransfer / 100);
  const swapCount = config.txCount - ethCount - tokenCount; // Remainder goes to swap
  
  console.log(`   ETH transfers: ${ethCount}`);
  console.log(`   Token transfers: ${tokenCount}`);
  console.log(`   Swaps: ${swapCount}`);
  
  // Validate contracts are available for the required tx types
  if (tokenCount > 0 && !contracts.token) {
    throw new Error('Token address required for token transfers');
  }
  if (swapCount > 0 && (!contracts.router || !contracts.weth || !contracts.token)) {
    throw new Error('Router, WETH, and Token addresses required for swaps');
  }
  
  // Get nonces for all senders in parallel
  const noncePromises = senders.map(s => s.getNonce());
  const nonces = await Promise.all(noncePromises);
  const senderNonces = new Map(senders.map((s, i) => [s.address, nonces[i]]));
  
  // Get current fee data
  const feeData = await provider.getFeeData();
  const multiplier = BigInt(Math.floor((config.gasMultiplier || 2) * 100));
  const gasParams = {
    maxFeePerGas: (feeData.maxFeePerGas || feeData.gasPrice) * multiplier / 100n,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || 0n,
  };
  
  console.log(`   Gas price: ${ethers.formatUnits(feeData.gasPrice || 0n, 'gwei')} gwei (using ${config.gasMultiplier || 2}x buffer)`);
  
  // Create recipient addresses
  const ethRecipient = ethers.Wallet.createRandom().address;
  const tokenRecipient = ethers.Wallet.createRandom().address;
  
  // Transaction values
  const ethValue = ethers.parseEther(config.txValue || '0.0001');
  const tokenAmount = ethers.parseUnits(config.tokenTxValue || '100', 18); // 100 tokens per transfer
  const swapEthAmount = ethers.parseEther(config.swapValue || '0.001'); // 0.001 ETH per swap
  
  console.log(`   ETH value: ${config.txValue || '0.0001'} ETH per transfer`);
  if (tokenCount > 0) console.log(`   Token value: ${config.tokenTxValue || '100'} tokens per transfer`);
  if (swapCount > 0) console.log(`   Swap value: ${config.swapValue || '0.001'} ETH per swap`);
  
  // Build transaction assignment list (round-robin across senders)
  const txAssignments = [];
  
  // Create interleaved assignments for better distribution
  let ethRemaining = ethCount;
  let tokenRemaining = tokenCount;
  let swapRemaining = swapCount;
  
  while (ethRemaining > 0 || tokenRemaining > 0 || swapRemaining > 0) {
    if (ethRemaining > 0) {
      txAssignments.push(TX_TYPES.ETH_TRANSFER);
      ethRemaining--;
    }
    if (tokenRemaining > 0) {
      txAssignments.push(TX_TYPES.TOKEN_TRANSFER);
      tokenRemaining--;
    }
    if (swapRemaining > 0) {
      txAssignments.push(TX_TYPES.SWAP);
      swapRemaining--;
    }
  }
  
  // Build unsigned transactions
  const unsignedTxs = [];
  
  for (let i = 0; i < txAssignments.length; i++) {
    const txType = txAssignments[i];
    const senderIdx = i % senders.length;
    const sender = senders[senderIdx];
    const nonce = senderNonces.get(sender.address);
    senderNonces.set(sender.address, nonce + 1);
    
    let tx;
    
    switch (txType) {
      case TX_TYPES.ETH_TRANSFER:
        tx = generateEthTransferTx(
          sender, nonce, ethRecipient, ethValue, gasParams, chainId, config.gasLimit || 21000n
        );
        break;
        
      case TX_TYPES.TOKEN_TRANSFER:
        tx = generateTokenTransferTx(
          sender, nonce, contracts.token, tokenRecipient, tokenAmount, gasParams, chainId
        );
        break;
        
      case TX_TYPES.SWAP:
        tx = generateSwapTx(
          sender, nonce, contracts.router, contracts.weth, contracts.token, swapEthAmount, gasParams, chainId
        );
        break;
    }
    
    unsignedTxs.push({
      sender,
      tx,
      index: i,
      txType,
    });
  }
  
  // Build expected tx details for verification
  const expectedTxDetails = {
    senderAddresses: new Set(senders.map(s => s.address.toLowerCase())),
    txMix,
    counts: { ethCount, tokenCount, swapCount },
    recipients: {
      eth: ethRecipient.toLowerCase(),
      token: tokenRecipient.toLowerCase(),
    },
    contracts: {
      token: contracts.token?.toLowerCase(),
      router: contracts.router?.toLowerCase(),
      weth: contracts.weth?.toLowerCase(),
    },
  };
  
  console.log(`✅ Generated ${unsignedTxs.length} transactions across ${senders.length} senders`);
  
  return { unsignedTxs, expectedTxDetails };
}

// =============================================================================
// Transaction Signing
// =============================================================================

/**
 * Pre-sign all transactions
 * @param {Array} unsignedTxs - Array of { sender, tx, index, txType }
 * @param {Function} formatDuration - Duration formatter function
 * @returns {Promise<Object>} - { signedTxs, signDuration }
 */
export async function signTransactions(unsignedTxs, formatDuration) {
  console.log(`\n✍️  Pre-signing ${unsignedTxs.length} transactions...`);
  const signStartTime = Date.now();
  
  const signedTxs = [];
  const signBatchSize = 100;
  
  for (let i = 0; i < unsignedTxs.length; i += signBatchSize) {
    const batch = unsignedTxs.slice(i, i + signBatchSize);
    
    const signPromises = batch.map(async ({ sender, tx, index, txType }) => {
      try {
        const signedTx = await sender.signTransaction(tx);
        return { signedTx, index, expectedFrom: sender.address.toLowerCase(), txType };
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
  
  return { signedTxs, signDuration };
}

// =============================================================================
// Funding Calculator
// =============================================================================

/**
 * Calculate how much ETH and tokens each sender needs
 * @param {Object} config
 * @param {number} senderCount
 * @returns {Object} - { ethPerSender, tokensPerSender }
 */
export function calculateFundingNeeds(config, senderCount) {
  const txMix = config.txMix || { ethTransfer: 100, tokenTransfer: 0, swap: 0 };
  const txPerSender = Math.ceil(config.txCount / senderCount);
  
  // ETH needs: transfers + swaps + gas for all tx types
  const ethTransfersPerSender = Math.ceil(txPerSender * txMix.ethTransfer / 100);
  const swapsPerSender = Math.ceil(txPerSender * txMix.swap / 100);
  const tokenTransfersPerSender = Math.ceil(txPerSender * txMix.tokenTransfer / 100);
  
  const ethValue = ethers.parseEther(config.txValue || '0.0001');
  const swapValue = ethers.parseEther(config.swapValue || '0.001');
  
  // Gas estimates
  const ethTransferGas = 21000n;
  const tokenTransferGas = 100000n;
  const swapGas = 200000n;
  const gasPrice = ethers.parseUnits('1', 'gwei') * BigInt(Math.floor((config.gasMultiplier || 2) * 2)); // Extra buffer
  
  const ethForTransfers = ethValue * BigInt(ethTransfersPerSender);
  const ethForSwaps = swapValue * BigInt(swapsPerSender);
  const ethForGas = gasPrice * (
    ethTransferGas * BigInt(ethTransfersPerSender) +
    tokenTransferGas * BigInt(tokenTransfersPerSender) +
    swapGas * BigInt(swapsPerSender)
  );
  
  const ethPerSender = ethForTransfers + ethForSwaps + ethForGas + ethers.parseEther('0.01'); // Extra buffer
  
  // Token needs: transfers only (swaps buy tokens, not spend them in ETH->Token direction)
  const tokenAmount = ethers.parseUnits(config.tokenTxValue || '100', 18);
  const tokensPerSender = tokenAmount * BigInt(tokenTransfersPerSender) + ethers.parseUnits('1000', 18); // Buffer
  
  return {
    ethPerSender,
    tokensPerSender,
    breakdown: {
      ethTransfersPerSender,
      tokenTransfersPerSender,
      swapsPerSender,
    },
  };
}

// =============================================================================
// Exports
// =============================================================================

export default {
  TX_TYPES,
  ERC20_ABI,
  ROUTER_ABI,
  parseTxMix,
  getRequiredContracts,
  generatePayload,
  signTransactions,
  calculateFundingNeeds,
};
