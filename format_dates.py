import os
import re

directory = r'd:\hsk development\apps\docsnx\src\app'

files_to_fix = [
    'follow-up/page.js',
    'investments/page.js',
    'lic-mediclaim/page.js',
    'medical/page.js',
    'rentals/page.js',
    'vehicles/page.js',
    'warranty/page.js'
]

pattern1 = re.compile(r"new Date\(([^)]+)\)\.toLocaleDateString\((?:'en-GB')?\)")
pattern2 = re.compile(r"date\.toLocaleDateString\(\)")

for rel_path in files_to_fix:
    path = os.path.join(directory, rel_path)
    if not os.path.exists(path): continue
    
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()
        
    has_import = "import { formatDate } from '@/lib/dateHelper';" in content or "import { formatDate" in content
    
    # replace pattern1
    # new Date(X).toLocaleDateString() -> formatDate(X)
    new_content = pattern1.sub(r'formatDate(\1)', content)
    
    # replace pattern2 (specifically in vehicles page)
    # date.toLocaleDateString() -> formatDate(date)
    new_content = pattern2.sub(r'formatDate(date)', new_content)
    
    if new_content != content:
        if not has_import:
            # Add import at the top
            lines = new_content.split('\n')
            for i, line in enumerate(lines):
                if line.startswith('import '):
                    lines.insert(i, "import { formatDate } from '@/lib/dateHelper';")
                    break
            new_content = '\n'.join(lines)
            
        with open(path, 'w', encoding='utf-8') as f:
            f.write(new_content)
        print(f'Updated {rel_path}')

