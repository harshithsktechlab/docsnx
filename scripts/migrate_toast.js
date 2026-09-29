const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '..', 'src', 'app');

function walkDir(dir) {
    let results = [];
    const list = fs.readdirSync(dir);
    list.forEach((file) => {
        file = path.join(dir, file);
        const stat = fs.statSync(file);
        if (stat && stat.isDirectory()) {
            results = results.concat(walkDir(file));
        } else if (file.endsWith('.js') || file.endsWith('.jsx')) {
            results.push(file);
        }
    });
    return results;
}

const files = walkDir(srcDir);

for (const file of files) {
    let content = fs.readFileSync(file, 'utf8');
    let changed = false;

    // Fast check
    if (!content.includes('alert(') && !content.includes('<Alert') && !content.includes('setError(')) {
        continue;
    }

    // Skip auth pages since we already did them manually
    if (file.includes('\\login\\') || file.includes('\\register\\') || file.includes('\\forgot-password\\') || file.includes('\\reset-password\\')) {
        continue;
    }

    // 1. Add toast import if we're going to use it
    if ((content.includes('alert(') || content.includes('setError(') || content.includes('setSuccess(')) && !content.includes("import { toast }")) {
        // Find last import
        const lines = content.split('\n');
        let lastImportIdx = 0;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('import ')) lastImportIdx = i;
        }
        lines.splice(lastImportIdx + 1, 0, "import { toast } from 'sonner';");
        content = lines.join('\n');
        changed = true;
    }

    // 2. Replace raw alert('something error') -> toast.error, etc.
    if (content.includes('alert(')) {
        content = content.replace(/alert\((['"`])(.*?)(['"`])\)/g, (match, p1, p2, p3) => {
            const text = p2.toLowerCase();
            if (text.includes('copied') || text.includes('success')) {
                return `toast.success(${p1}${p2}${p3})`;
            } else if (text.includes('error') || text.includes('failed') || text.includes('must') || text.includes('please')) {
                return `toast.error(${p1}${p2}${p3})`;
            }
            return `toast.info(${p1}${p2}${p3})`;
        });
        changed = true;
    }

    // 3. Remove Alert variants that are destructive
    if (content.includes('variant="destructive"')) {
        // Regex to remove <Alert variant="destructive">...</Alert> blocks roughly
        const alertRegex = /\{\s*[a-zA-Z0-9_]+\s*&&\s*\(\s*<Alert variant="destructive"[^>]*>[\s\S]*?<\/Alert>\s*\)\s*\}/g;
        content = content.replace(alertRegex, '');
        // Also remove plain blocks without {}
        const plainAlertRegex = /<Alert variant="destructive"[^>]*>[\s\S]*?<\/Alert>/g;
        content = content.replace(plainAlertRegex, '');
        changed = true;
    }

    // 4. Also replace setSuccess and setError calls inside the logic if we can assume they just display a toast now?
    // Actually, setError might be used to conditionally disable a button. So it's better NOT to delete setError/setSuccess completely,
    // but we can append a toast.error/success call next to it.
    // e.g. setError('foo') -> setError('foo'); toast.error('foo')
    // But this regex is tricky to get right without AST parsing.

    if (changed) {
        fs.writeFileSync(file, content, 'utf8');
        console.log('Migrated toast logic in', file);
    }
}
