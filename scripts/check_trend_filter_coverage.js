#!/usr/bin/env node

/**
 * Script to check if all order execution paths go through trend filter
 * 
 * This script analyzes the codebase to ensure all signals that reach OrderService
 * have passed through the trend filter gate.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { glob } from 'glob';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

// Files to check
const filesToCheck = [
  'src/consumers/WebSocketOCConsumer.js',
  'src/jobs/PriceAlertScanner.js',
  'src/services/OrderService.js'
];

console.log('🔍 Checking Trend Filter Coverage...\n');
console.log('='.repeat(80));

let allPassed = true;
const results = [];

for (const filePath of filesToCheck) {
  const fullPath = join(projectRoot, filePath);
  try {
    const content = readFileSync(fullPath, 'utf-8');
    const lines = content.split('\n');
    
    console.log(`\n📄 Checking: ${filePath}`);
    console.log('-'.repeat(80));
    
    // Find all executeSignal calls
    const executeSignalCalls = [];
    lines.forEach((line, index) => {
      if (line.includes('executeSignal') || line.includes('orderService.executeSignal')) {
        executeSignalCalls.push({ line: index + 1, content: line.trim() });
      }
    });
    
    if (executeSignalCalls.length === 0) {
      console.log('  ✅ No executeSignal calls found (not an entry point)');
      continue;
    }
    
    console.log(`  Found ${executeSignalCalls.length} executeSignal call(s):`);
    executeSignalCalls.forEach(({ line, content }) => {
      console.log(`    Line ${line}: ${content.substring(0, 80)}...`);
    });
    
    // Check if trend filter is present before executeSignal
    let hasFilter = false;
    let filterLines = [];
    
    // Check for isTrendConfirmed calls
    const trendFilterPatterns = [
      /isTrendConfirmed/,
      /trend.*filter/i,
      /Trend.*filter/i,
      /verdict.*ok/,
      /filterIndicatorState/
    ];
    
    lines.forEach((line, index) => {
      trendFilterPatterns.forEach(pattern => {
        if (pattern.test(line)) {
          filterLines.push({ line: index + 1, content: line.trim() });
        }
      });
    });
    
    // Check if filter appears before executeSignal
    if (filterLines.length > 0) {
      const lastFilterLine = filterLines[filterLines.length - 1].line;
      const firstExecuteLine = executeSignalCalls[0].line;
      
      if (lastFilterLine < firstExecuteLine) {
        hasFilter = true;
        console.log(`  ✅ Trend filter found BEFORE executeSignal (filter at line ${lastFilterLine}, executeSignal at line ${firstExecuteLine})`);
      } else {
        console.log(`  ⚠️  Trend filter found AFTER executeSignal (filter at line ${lastFilterLine}, executeSignal at line ${firstExecuteLine})`);
        hasFilter = false;
      }
    } else {
      console.log(`  ❌ NO trend filter found in this file!`);
      hasFilter = false;
    }
    
    // Check for early returns after filter rejection
    let hasEarlyReturn = false;
    lines.forEach((line, index) => {
      if (line.includes('continue') || line.includes('return') && index < executeSignalCalls[0]?.line) {
        // Check if it's in a filter rejection context
        if (line.includes('rejected') || line.includes('REJECTED') || line.includes('verdict') || line.includes('!verdict.ok')) {
          hasEarlyReturn = true;
        }
      }
    });
    
    if (hasFilter && hasEarlyReturn) {
      console.log(`  ✅ Early return on filter rejection found`);
    } else if (hasFilter && !hasEarlyReturn) {
      console.log(`  ⚠️  Filter found but no early return on rejection`);
    }
    
    // Check for counter-trend strategy bypass
    let hasCounterTrendCheck = false;
    lines.forEach((line, index) => {
      if (line.includes('is_reverse_strategy') || line.includes('COUNTER_TREND')) {
        hasCounterTrendCheck = true;
      }
    });
    
    if (hasCounterTrendCheck) {
      console.log(`  ✅ Counter-trend strategy check found`);
    }
    
    results.push({
      file: filePath,
      hasFilter,
      hasEarlyReturn,
      hasCounterTrendCheck,
      executeSignalCount: executeSignalCalls.length,
      filterCount: filterLines.length
    });
    
    if (!hasFilter) {
      allPassed = false;
    }
    
  } catch (error) {
    console.error(`  ❌ Error reading file: ${error.message}`);
    allPassed = false;
  }
}

console.log('\n' + '='.repeat(80));
console.log('\n📊 Summary:');
console.log('-'.repeat(80));

results.forEach(result => {
  const status = result.hasFilter ? '✅' : '❌';
  console.log(`${status} ${result.file}`);
  console.log(`   - Has trend filter: ${result.hasFilter ? 'YES' : 'NO'}`);
  console.log(`   - Has early return: ${result.hasEarlyReturn ? 'YES' : 'NO'}`);
  console.log(`   - Has counter-trend check: ${result.hasCounterTrendCheck ? 'YES' : 'NO'}`);
  console.log(`   - executeSignal calls: ${result.executeSignalCount}`);
  console.log(`   - Filter checks: ${result.filterCount}`);
  console.log('');
});

console.log('='.repeat(80));

if (allPassed) {
  console.log('\n✅ ALL entry points have trend filter protection!');
  process.exit(0);
} else {
  console.log('\n❌ Some entry points are missing trend filter protection!');
  console.log('\n⚠️  Please review the files marked with ❌ above.');
  process.exit(1);
}

