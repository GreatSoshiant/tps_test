import { ethers } from 'ethers';
import { deployToken } from './deploy-token.js';
import { deployUniswap } from './deploy-uniswap.js';

/**
 * Full DEX Setup Script
 * 
 * 1. Deploys a test ERC20 token
 * 2. Deploys Uniswap V2 (WETH, Factory, Router)
 * 3. Creates a Token/WETH liquidity pool
 * 4. Adds initial liquidity for swapping
 */

// =============================================================================
// Configuration
// =============================================================================

const CONFIG = {
  rpcUrl: process.env.RPC_URL || 'http://127.0.0.1:8547',
  
  // Pre-funded dev account from nitro-devnode
  deployerPrivateKey: '0xb6b15c8cb491557369f3c7d2c287b053eb229daa9c22138887752191c9520659',
  
  // Token settings
  token: {
    name: 'Test Token',
    symbol: 'TEST',
    decimals: 18,
    initialSupply: '1000000000', // 1 billion tokens
  },
  
  // Liquidity settings (cheap token = lots of tokens per ETH)
  liquidity: {
    ethAmount: '10',           // 10 ETH
    tokenAmount: '100000000',  // 100 million tokens (10M tokens per ETH = very cheap)
  },
};

// =============================================================================
// Parse CLI Arguments
// =============================================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const config = JSON.parse(JSON.stringify(CONFIG)); // Deep clone
  
  for (const arg of args) {
    const [key, value] = arg.replace('--', '').split('=');
    if (key === 'rpcUrl') config.rpcUrl = value;
    if (key === 'privateKey') config.deployerPrivateKey = value;
    if (key === 'tokenName') config.token.name = value;
    if (key === 'tokenSymbol') config.token.symbol = value;
    if (key === 'ethAmount') config.liquidity.ethAmount = value;
    if (key === 'tokenAmount') config.liquidity.tokenAmount = value;
  }
  
  return config;
}

// =============================================================================
// Main Setup Function
// =============================================================================

async function setupDex(config) {
  console.log('🚀 FULL DEX SETUP');
  console.log('='.repeat(60));
  console.log('This script will:');
  console.log('  1. Deploy a test ERC20 token');
  console.log('  2. Deploy Uniswap V2 (WETH, Factory, Router)');
  console.log('  3. Create a Token/WETH liquidity pool');
  console.log('  4. Add initial liquidity for swapping');
  console.log('='.repeat(60));
  
  // Connect to provider
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const deployer = new ethers.Wallet(config.deployerPrivateKey, provider);
  
  console.log(`\n🔗 RPC: ${config.rpcUrl}`);
  console.log(`💰 Deployer: ${deployer.address}`);
  
  const initialBalance = await provider.getBalance(deployer.address);
  console.log(`   Balance: ${ethers.formatEther(initialBalance)} ETH`);
  
  // =========================================================================
  // Step 1: Deploy Token
  // =========================================================================
  console.log('\n' + '─'.repeat(60));
  console.log('📦 STEP 1: Deploying Test Token...');
  console.log('─'.repeat(60));
  
  const tokenResult = await deployToken({
    rpcUrl: config.rpcUrl,
    deployerPrivateKey: config.deployerPrivateKey,
    tokenName: config.token.name,
    tokenSymbol: config.token.symbol,
    tokenDecimals: config.token.decimals,
    initialSupply: config.token.initialSupply,
  });
  
  const tokenAddress = tokenResult.contractAddress;
  const tokenAbi = tokenResult.abi;
  console.log(`✅ Token deployed: ${tokenAddress}`);
  
  // =========================================================================
  // Step 2: Deploy Uniswap V2
  // =========================================================================
  console.log('\n' + '─'.repeat(60));
  console.log('🦄 STEP 2: Deploying Uniswap V2...');
  console.log('─'.repeat(60));
  
  const uniswapResult = await deployUniswap({
    rpcUrl: config.rpcUrl,
    deployerPrivateKey: config.deployerPrivateKey,
  });
  
  const wethAddress = uniswapResult.weth.address;
  const factoryAddress = uniswapResult.factory.address;
  const routerAddress = uniswapResult.router.address;
  const routerAbi = uniswapResult.router.abi;
  const factoryAbi = uniswapResult.factory.abi;
  
  console.log(`✅ WETH: ${wethAddress}`);
  console.log(`✅ Factory: ${factoryAddress}`);
  console.log(`✅ Router: ${routerAddress}`);
  
  // =========================================================================
  // Step 3: Approve Router to spend tokens
  // =========================================================================
  console.log('\n' + '─'.repeat(60));
  console.log('🔓 STEP 3: Approving Router to spend tokens...');
  console.log('─'.repeat(60));
  
  const token = new ethers.Contract(tokenAddress, tokenAbi, deployer);
  const tokenAmountWei = ethers.parseUnits(config.liquidity.tokenAmount, config.token.decimals);
  
  // Get fresh nonce
  let nonce = await provider.getTransactionCount(deployer.address, 'pending');
  
  const approveTx = await token.approve(routerAddress, tokenAmountWei, { nonce: nonce++ });
  await approveTx.wait();
  
  const allowance = await token.allowance(deployer.address, routerAddress);
  console.log(`✅ Approved ${ethers.formatUnits(allowance, config.token.decimals)} ${config.token.symbol} for Router`);
  
  // =========================================================================
  // Step 4: Add Liquidity (creates pool automatically)
  // =========================================================================
  console.log('\n' + '─'.repeat(60));
  console.log('💧 STEP 4: Adding Liquidity (Token/ETH pool)...');
  console.log('─'.repeat(60));
  
  const router = new ethers.Contract(routerAddress, routerAbi, deployer);
  const ethAmountWei = ethers.parseEther(config.liquidity.ethAmount);
  
  console.log(`   Token amount: ${config.liquidity.tokenAmount} ${config.token.symbol}`);
  console.log(`   ETH amount: ${config.liquidity.ethAmount} ETH`);
  console.log(`   Price: 1 ETH = ${Number(config.liquidity.tokenAmount) / Number(config.liquidity.ethAmount)} ${config.token.symbol}`);
  
  // Deadline: 20 minutes from now
  const deadline = Math.floor(Date.now() / 1000) + 20 * 60;
  
  const addLiquidityTx = await router.addLiquidityETH(
    tokenAddress,           // token address
    tokenAmountWei,         // token amount desired
    tokenAmountWei,         // token amount min (same as desired for initial liquidity)
    ethAmountWei,           // ETH amount min
    deployer.address,       // LP tokens recipient
    deadline,               // deadline
    { 
      value: ethAmountWei,  // ETH to send
      nonce: nonce++,
      gasLimit: 5000000,    // Higher gas limit for pair creation
    }
  );
  
  console.log(`   Tx hash: ${addLiquidityTx.hash}`);
  const receipt = await addLiquidityTx.wait();
  console.log(`✅ Liquidity added! Gas used: ${receipt.gasUsed.toString()}`);
  
  // =========================================================================
  // Step 5: Verify Pool Creation
  // =========================================================================
  console.log('\n' + '─'.repeat(60));
  console.log('🔍 STEP 5: Verifying Pool...');
  console.log('─'.repeat(60));
  
  const factory = new ethers.Contract(factoryAddress, factoryAbi, provider);
  const pairAddress = await factory.getPair(tokenAddress, wethAddress);
  
  if (pairAddress === ethers.ZeroAddress) {
    throw new Error('Pair was not created!');
  }
  
  console.log(`✅ Pair address: ${pairAddress}`);
  
  // Get pair reserves
  const pairAbi = [
    'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function totalSupply() view returns (uint256)',
  ];
  const pair = new ethers.Contract(pairAddress, pairAbi, provider);
  
  const [reserve0, reserve1] = await pair.getReserves();
  const token0 = await pair.token0();
  const lpSupply = await pair.totalSupply();
  
  // Determine which reserve is which
  const isToken0 = token0.toLowerCase() === tokenAddress.toLowerCase();
  const tokenReserve = isToken0 ? reserve0 : reserve1;
  const wethReserve = isToken0 ? reserve1 : reserve0;
  
  console.log(`   Token reserve: ${ethers.formatUnits(tokenReserve, config.token.decimals)} ${config.token.symbol}`);
  console.log(`   WETH reserve: ${ethers.formatEther(wethReserve)} WETH`);
  console.log(`   LP tokens minted: ${ethers.formatEther(lpSupply)}`);
  
  // =========================================================================
  // Summary
  // =========================================================================
  const finalBalance = await provider.getBalance(deployer.address);
  const ethSpent = initialBalance - finalBalance;
  
  console.log('\n' + '='.repeat(60));
  console.log('🎉 DEX SETUP COMPLETE!');
  console.log('='.repeat(60));
  console.log('\n📝 DEPLOYED CONTRACTS:');
  console.log(`   Token (${config.token.symbol}):  ${tokenAddress}`);
  console.log(`   WETH:              ${wethAddress}`);
  console.log(`   Factory:           ${factoryAddress}`);
  console.log(`   Router:            ${routerAddress}`);
  console.log(`   Pair:              ${pairAddress}`);
  
  console.log('\n💱 POOL INFO:');
  console.log(`   Token/ETH Price: 1 ETH = ${Number(config.liquidity.tokenAmount) / Number(config.liquidity.ethAmount)} ${config.token.symbol}`);
  console.log(`   Token/ETH Price: 1 ${config.token.symbol} = ${Number(config.liquidity.ethAmount) / Number(config.liquidity.tokenAmount)} ETH`);
  
  console.log('\n💰 COST:');
  console.log(`   ETH spent: ${ethers.formatEther(ethSpent)} ETH`);
  console.log(`   Remaining balance: ${ethers.formatEther(finalBalance)} ETH`);
  
  console.log('\n📖 EXAMPLE SWAPS:');
  console.log(`   // Swap ETH for tokens:`);
  console.log(`   router.swapExactETHForTokens(0, [WETH, Token], recipient, deadline, { value: ethAmount })`);
  console.log(`   // Swap tokens for ETH:`);
  console.log(`   router.swapExactTokensForETH(tokenAmount, 0, [Token, WETH], recipient, deadline)`);
  
  console.log('='.repeat(60));
  
  return {
    token: {
      address: tokenAddress,
      abi: tokenAbi,
      name: config.token.name,
      symbol: config.token.symbol,
      decimals: config.token.decimals,
    },
    weth: {
      address: wethAddress,
    },
    factory: {
      address: factoryAddress,
      abi: factoryAbi,
    },
    router: {
      address: routerAddress,
      abi: routerAbi,
    },
    pair: {
      address: pairAddress,
    },
    deployer: deployer.address,
  };
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const config = parseArgs();
  
  try {
    const result = await setupDex(config);
    
    // Output JSON for programmatic use
    console.log('\n📤 JSON Output:');
    console.log(JSON.stringify({
      token: result.token.address,
      weth: result.weth.address,
      factory: result.factory.address,
      router: result.router.address,
      pair: result.pair.address,
      deployer: result.deployer,
    }, null, 2));
    
    return result;
  } catch (err) {
    console.error(`\n❌ Setup failed: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }
}

// Run if called directly
main();

// Export for use as module
export { setupDex, CONFIG as DEFAULT_CONFIG };
