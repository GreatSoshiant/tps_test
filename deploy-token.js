import { ethers } from 'ethers';
import solc from 'solc';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * ERC20 Token Deployment Script
 * 
 * Compiles and deploys an ERC20 token using OpenZeppelin contracts.
 * All tokens are minted to the deployer.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============================================================================
// Configuration
// =============================================================================

const CONFIG = {
  rpcUrl: process.env.RPC_URL || 'http://127.0.0.1:8547',
  
  // Pre-funded dev account from nitro-devnode
  deployerPrivateKey: '0xb6b15c8cb491557369f3c7d2c287b053eb229daa9c22138887752191c9520659',
  
  // Token settings
  tokenName: 'Test Token',
  tokenSymbol: 'TEST',
  tokenDecimals: 18,
  initialSupply: '1000000000', // 1 billion tokens
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
    if (key === 'name') config.tokenName = value;
    if (key === 'symbol') config.tokenSymbol = value;
    if (key === 'decimals') config.tokenDecimals = parseInt(value);
    if (key === 'supply') config.initialSupply = value;
    if (key === 'privateKey') config.deployerPrivateKey = value;
  }
  
  return config;
}

// =============================================================================
// Solidity Compiler
// =============================================================================

function findImports(importPath) {
  try {
    // Handle OpenZeppelin imports
    if (importPath.startsWith('@openzeppelin/')) {
      const ozPath = path.join(__dirname, 'node_modules', importPath);
      const content = fs.readFileSync(ozPath, 'utf8');
      return { contents: content };
    }
    
    // Handle local imports
    const localPath = path.join(__dirname, 'contracts', importPath);
    if (fs.existsSync(localPath)) {
      const content = fs.readFileSync(localPath, 'utf8');
      return { contents: content };
    }
    
    return { error: `File not found: ${importPath}` };
  } catch (err) {
    return { error: err.message };
  }
}

function compileContract() {
  console.log('🔨 Compiling contract with OpenZeppelin...');
  
  const contractPath = path.join(__dirname, 'contracts', 'TestToken.sol');
  const source = fs.readFileSync(contractPath, 'utf8');
  
  const input = {
    language: 'Solidity',
    sources: {
      'TestToken.sol': {
        content: source,
      },
    },
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      outputSelection: {
        '*': {
          '*': ['abi', 'evm.bytecode.object'],
        },
      },
    },
  };
  
  const output = JSON.parse(
    solc.compile(JSON.stringify(input), { import: findImports })
  );
  
  // Check for errors
  if (output.errors) {
    const errors = output.errors.filter(e => e.severity === 'error');
    if (errors.length > 0) {
      console.error('❌ Compilation errors:');
      errors.forEach(e => console.error(e.formattedMessage));
      process.exit(1);
    }
    
    // Show warnings
    const warnings = output.errors.filter(e => e.severity === 'warning');
    if (warnings.length > 0) {
      console.log(`   ⚠️  ${warnings.length} warnings (ignored)`);
    }
  }
  
  const contract = output.contracts['TestToken.sol']['TestToken'];
  
  console.log('✅ Compilation successful!');
  
  return {
    abi: contract.abi,
    bytecode: '0x' + contract.evm.bytecode.object,
  };
}

// =============================================================================
// Deploy Token
// =============================================================================

async function deployToken(config) {
  console.log('🪙  ERC20 Token Deployment (OpenZeppelin)');
  console.log('='.repeat(50));
  
  // Compile contract
  const { abi, bytecode } = compileContract();
  
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
  
  // Token details
  const supplyWithDecimals = ethers.parseUnits(config.initialSupply, config.tokenDecimals);
  
  console.log(`\n📋 Token Details:`);
  console.log(`   Name:     ${config.tokenName}`);
  console.log(`   Symbol:   ${config.tokenSymbol}`);
  console.log(`   Decimals: ${config.tokenDecimals}`);
  console.log(`   Supply:   ${config.initialSupply} ${config.tokenSymbol}`);
  
  // Create contract factory
  console.log(`\n🚀 Deploying token contract...`);
  
  const factory = new ethers.ContractFactory(abi, bytecode, deployer);
  
  // Deploy with constructor arguments
  const contract = await factory.deploy(
    config.tokenName,
    config.tokenSymbol,
    config.tokenDecimals,
    supplyWithDecimals
  );
  
  console.log(`   Transaction hash: ${contract.deploymentTransaction().hash}`);
  console.log(`   Waiting for confirmation...`);
  
  // Wait for deployment
  await contract.waitForDeployment();
  const contractAddress = await contract.getAddress();
  
  console.log(`\n✅ Token deployed successfully!`);
  console.log(`   Contract address: ${contractAddress}`);
  
  // Verify deployment
  console.log(`\n🔍 Verifying deployment...`);
  
  const tokenContract = new ethers.Contract(contractAddress, abi, provider);
  
  const name = await tokenContract.name();
  const symbol = await tokenContract.symbol();
  const decimals = await tokenContract.decimals();
  const totalSupply = await tokenContract.totalSupply();
  const deployerTokenBalance = await tokenContract.balanceOf(deployer.address);
  
  console.log(`   Name:             ${name}`);
  console.log(`   Symbol:           ${symbol}`);
  console.log(`   Decimals:         ${decimals}`);
  console.log(`   Total Supply:     ${ethers.formatUnits(totalSupply, decimals)} ${symbol}`);
  console.log(`   Deployer Balance: ${ethers.formatUnits(deployerTokenBalance, decimals)} ${symbol}`);
  
  // Confirm all supply is with deployer
  if (deployerTokenBalance === totalSupply) {
    console.log(`\n✅ All tokens are in deployer's wallet!`);
  } else {
    console.log(`\n⚠️  Token distribution mismatch!`);
  }
  
  console.log('\n' + '='.repeat(50));
  console.log('📝 DEPLOYMENT SUMMARY');
  console.log('='.repeat(50));
  console.log(`Contract Address: ${contractAddress}`);
  console.log(`Token Name:       ${name}`);
  console.log(`Token Symbol:     ${symbol}`);
  console.log(`Total Supply:     ${ethers.formatUnits(totalSupply, decimals)}`);
  console.log('='.repeat(50));
  
  return {
    contractAddress,
    abi,
    tokenName: name,
    tokenSymbol: symbol,
    tokenDecimals: Number(decimals),
    totalSupply: totalSupply.toString(),
    deployer: deployer.address,
  };
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const config = parseArgs();
  
  try {
    const result = await deployToken(config);
    
    // Output JSON for programmatic use
    console.log('\n📤 JSON Output:');
    console.log(JSON.stringify({
      contractAddress: result.contractAddress,
      tokenName: result.tokenName,
      tokenSymbol: result.tokenSymbol,
      tokenDecimals: result.tokenDecimals,
      totalSupply: result.totalSupply,
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
export { deployToken, compileContract, CONFIG as DEFAULT_CONFIG };
