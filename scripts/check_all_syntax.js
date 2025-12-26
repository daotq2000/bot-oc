#!/usr/bin/env node
/**
 * Script to check all JavaScript files for syntax errors
 */

import { readdir, stat } from 'fs/promises';
import { join, extname } from 'path';
import { execSync } from 'child_process';

const errors = [];
const checked = [];

async function checkFile(filePath) {
  try {
    execSync(`node -c "${filePath}"`, { stdio: 'pipe' });
    checked.push({ file: filePath, status: 'OK' });
    return true;
  } catch (error) {
    const errorMsg = error.stderr?.toString() || error.message || 'Unknown error';
    errors.push({ file: filePath, error: errorMsg });
    checked.push({ file: filePath, status: 'ERROR' });
    return false;
  }
}

async function walkDir(dir, fileList = []) {
  const files = await readdir(dir);
  
  for (const file of files) {
    const filePath = join(dir, file);
    const fileStat = await stat(filePath);
    
    if (fileStat.isDirectory()) {
      // Skip node_modules, .git, coverage, logs
      if (file.startsWith('.') || file === 'node_modules' || file === 'coverage' || file === 'logs') {
        continue;
      }
      await walkDir(filePath, fileList);
    } else if (extname(file) === '.js') {
      fileList.push(filePath);
    }
  }
  
  return fileList;
}

async function main() {
  console.log('='.repeat(70));
  console.log('Checking all JavaScript files for syntax errors...');
  console.log('='.repeat(70));
  console.log();
  
  const srcFiles = await walkDir('src');
  const testFiles = await walkDir('tests');
  const scriptFiles = await walkDir('scripts');
  
  const allFiles = [...srcFiles, ...testFiles, ...scriptFiles];
  
  console.log(`Found ${allFiles.length} JavaScript files to check\n`);
  
  // Check all files
  for (const file of allFiles) {
    process.stdout.write(`Checking ${file}... `);
    await checkFile(file);
    process.stdout.write(checked[checked.length - 1].status === 'OK' ? '✓\n' : '✗\n');
  }
  
  console.log();
  console.log('='.repeat(70));
  console.log('Summary');
  console.log('='.repeat(70));
  console.log(`Total files checked: ${checked.length}`);
  console.log(`Files OK: ${checked.filter(c => c.status === 'OK').length}`);
  console.log(`Files with errors: ${errors.length}`);
  console.log();
  
  if (errors.length > 0) {
    console.log('='.repeat(70));
    console.log('Errors found:');
    console.log('='.repeat(70));
    errors.forEach(({ file, error }) => {
      console.log(`\nFile: ${file}`);
      console.log(`Error: ${error}`);
    });
    process.exit(1);
  } else {
    console.log('✅ All files passed syntax check!');
    process.exit(0);
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

