// Official Khronos validation. This does not claim rendering or physical accuracy.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const validator = require(path.join(root, 'project_support/environment/visual_assets/node_modules/gltf-validator'));
const library = path.join(root, 'digital_twin/model_library/visual_assets');
const output = path.join(root, 'data/workspace/visual_assets');
async function main() {
  fs.mkdirSync(output, {recursive: true});
  const catalog = JSON.parse(fs.readFileSync(path.join(library, 'catalog.json')));
  const results = [];
  for (const row of catalog.assets) {
    const metaFile = path.join(library, row.metadata);
    const meta = JSON.parse(fs.readFileSync(metaFile));
    const bytes = fs.readFileSync(path.join(path.dirname(metaFile), meta.model.path));
    const report = await validator.validateBytes(new Uint8Array(bytes), {uri: row.asset_id + '.glb', maxIssues: 1000});
    const record = {asset_id: row.asset_id, sha256: meta.model.sha256, issues: report.issues};
    results.push(record);
    meta.validation.gltf_validator = report.issues.numErrors === 0 ? 'passed' : 'failed';
    meta.validation.gltf_validator_version = validator.version();
    meta.validation.gltf_errors = report.issues.numErrors;
    meta.validation.gltf_warnings = report.issues.numWarnings;
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n');
    if (report.issues.numErrors) console.log(row.asset_id, report.issues.numErrors, [...new Set(report.issues.messages.filter(x=>x.severity===0).map(x=>x.code))].join(','));
  }
  const summary = {validator: validator.version(), assets: results.length, failed: results.filter(x=>x.issues.numErrors>0).length, results};
  fs.writeFileSync(path.join(output, 'gltf_validation.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({assets: summary.assets, failed: summary.failed}));
  process.exitCode = summary.failed ? 1 : 0;
}
main().catch(e=>{console.error(e); process.exitCode=1});
