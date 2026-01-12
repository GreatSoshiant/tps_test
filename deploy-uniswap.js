import { ethers } from 'ethers';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);

/**
 * Uniswap V2 Deployment Script
 * 
 * Deploys the complete Uniswap V2 stack using official Uniswap npm packages:
 * - @uniswap/v2-core (Factory, Pair)
 * - @uniswap/v2-periphery (Router02, WETH9)
 */

// =============================================================================
// Import Official Uniswap Contracts
// =============================================================================

// From @uniswap/v2-core
const UniswapV2Factory = require('@uniswap/v2-core/build/UniswapV2Factory.json');

// From @uniswap/v2-periphery
const UniswapV2Router02 = require('@uniswap/v2-periphery/build/UniswapV2Router02.json');
const WETH9 = require('@uniswap/v2-periphery/build/WETH9.json');

// =============================================================================
// Configuration
// =============================================================================

const CONFIG = {
  rpcUrl: process.env.RPC_URL || 'http://127.0.0.1:8547',
  
  // Pre-funded dev account from nitro-devnode
  deployerPrivateKey: '0xb6b15c8cb491557369f3c7d2c287b053eb229daa9c22138887752191c9520659',
};

// =============================================================================
// Parse CLI Arguments
// =============================================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { ...CONFIG };
  
  for (const arg of args) {
    const [key, value] = arg.replace('--', '').split('=');
    if (key === 'rpcUrl') config.rpcUrl = value;
    if (key === 'privateKey') config.deployerPrivateKey = value;
  }
  
  return config;
}

// =============================================================================
// Deploy Contracts
// =============================================================================

async function deployUniswap(config) {
  console.log('🦄 Uniswap V2 Deployment (Official Packages)');
  console.log('='.repeat(50));
  console.log('   Using: @uniswap/v2-core');
  console.log('   Using: @uniswap/v2-periphery');
  
  // Connect to provider
  console.log(`\n🔗 Connecting to ${config.rpcUrl}...`);
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  
  try {
    const network = await provider.getNetwork();
    console.log(`✅ Connected to chain ID: ${network.chainId}`);
  } catch (err) {
    console.error(`❌ Failed to connect: ${err.message}`);
    process.exit(1);
  }
  
  // Setup deployer wallet
  const deployer = new ethers.Wallet(config.deployerPrivateKey, provider);
  const deployerBalance = await provider.getBalance(deployer.address);
  
  console.log(`\n💰 Deployer: ${deployer.address}`);
  console.log(`   Balance: ${ethers.formatEther(deployerBalance)} ETH`);
  
  // ==========================================================================
  // 1. Deploy WETH9
  // ==========================================================================
  console.log(`\n${'─'.repeat(50)}`);
  console.log('📦 Step 1: Deploying WETH9...');
  console.log('   Source: @uniswap/v2-periphery/build/WETH9.json');
  
  // Get fresh nonce to avoid caching issues
  let nonce = await provider.getTransactionCount(deployer.address, 'pending');
  console.log(`   Using nonce: ${nonce}`);
  
  const wethFactory = new ethers.ContractFactory(
    WETH9.abi,
    WETH9.bytecode,
    deployer
  );
  const weth = await wethFactory.deploy({ nonce: nonce++ });
  await weth.waitForDeployment();
  const wethAddress = await weth.getAddress();
  
  console.log(`✅ WETH9 deployed at: ${wethAddress}`);
  
  // Verify WETH
  const wethContract = new ethers.Contract(wethAddress, WETH9.abi, provider);
  const wethName = await wethContract.name();
  const wethSymbol = await wethContract.symbol();
  console.log(`   Name: ${wethName}, Symbol: ${wethSymbol}`);
  
  // ==========================================================================
  // 2. Deploy UniswapV2Factory
  // ==========================================================================
  console.log(`\n${'─'.repeat(50)}`);
  console.log('📦 Step 2: Deploying UniswapV2Factory...');
  console.log('   Source: @uniswap/v2-core/build/UniswapV2Factory.json');
  console.log(`   Using nonce: ${nonce}`);
  
  const factoryFactory = new ethers.ContractFactory(
    UniswapV2Factory.abi,
    UniswapV2Factory.bytecode,
    deployer
  );
  const factory = await factoryFactory.deploy(deployer.address, { nonce: nonce++ }); // feeToSetter = deployer
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  
  console.log(`✅ UniswapV2Factory deployed at: ${factoryAddress}`);
  
  // Verify Factory
  const factoryContract = new ethers.Contract(factoryAddress, UniswapV2Factory.abi, provider);
  const feeToSetter = await factoryContract.feeToSetter();
  const allPairsLength = await factoryContract.allPairsLength();
  console.log(`   FeeToSetter: ${feeToSetter}`);
  console.log(`   Initial pairs: ${allPairsLength}`);
  
  // ==========================================================================
  // 3. Deploy UniswapV2Router02
  // ==========================================================================
  console.log(`\n${'─'.repeat(50)}`);
  console.log('📦 Step 3: Deploying UniswapV2Router02...');
  console.log('   Source: @uniswap/v2-periphery/build/UniswapV2Router02.json');
  console.log(`   Using nonce: ${nonce}`);
  
  const routerFactory = new ethers.ContractFactory(
    UniswapV2Router02.abi,
    UniswapV2Router02.bytecode,
    deployer
  );
  const router = await routerFactory.deploy(factoryAddress, wethAddress, { nonce: nonce++ });
  await router.waitForDeployment();
  const routerAddress = await router.getAddress();
  
  console.log(`✅ UniswapV2Router02 deployed at: ${routerAddress}`);
  
  // Verify Router
  const routerContract = new ethers.Contract(routerAddress, UniswapV2Router02.abi, provider);
  const routerFactoryAddr = await routerContract.factory();
  const routerWETH = await routerContract.WETH();
  console.log(`   Factory: ${routerFactoryAddr}`);
  console.log(`   WETH: ${routerWETH}`);
  
  // ==========================================================================
  // Summary
  // ==========================================================================
  console.log('\n' + '='.repeat(50));
  console.log('📝 UNISWAP V2 DEPLOYMENT SUMMARY');
  console.log('='.repeat(50));
  console.log(`WETH9:              ${wethAddress}`);
  console.log(`UniswapV2Factory:   ${factoryAddress}`);
  console.log(`UniswapV2Router02:  ${routerAddress}`);
  console.log(`Deployer:           ${deployer.address}`);
  console.log('='.repeat(50));
  
  const result = {
    weth: {
      address: wethAddress,
      abi: WETH9.abi,
    },
    factory: {
      address: factoryAddress,
      abi: UniswapV2Factory.abi,
    },
    router: {
      address: routerAddress,
      abi: UniswapV2Router02.abi,
    },
    deployer: deployer.address,
  };
  
  return result;
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const config = parseArgs();
  
  try {
    const result = await deployUniswap(config);
    
    // Output JSON for programmatic use
    console.log('\n📤 JSON Output:');
    console.log(JSON.stringify({
      weth: result.weth.address,
      factory: result.factory.address,
      router: result.router.address,
      deployer: result.deployer,
    }, null, 2));
    
    return result;
  } catch (err) {
    console.error(`\n❌ Deployment failed: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }
}

// Run if called directly (not imported as a module)
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  main();
}

// Export for use as module
export { deployUniswap, CONFIG as DEFAULT_CONFIG };
