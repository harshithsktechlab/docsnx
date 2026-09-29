const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/app/admin/plans/page.js');
let code = fs.readFileSync(filePath, 'utf8');

// Find the Button component for the Plan Status toggle
// It currently looks like:
/*
                <Button
                  type="button"
                  variant={formData.isActive ? "default" : "secondary"}
                  size="sm"
                  onClick={() => setFormData(prev => ({ ...prev, isActive: !prev.isActive }))}
                  className={cn("h-9 rounded-lg transition-all", formData.isActive ? "bg-emerald-500 hover:bg-emerald-600 text-white shadow-lg shadow-emerald-500/20" : "")}
                >
*/

code = code.replace(
  /variant=\{formData\.isActive \? "default" : "secondary"\}/g,
  `variant={formData.isActive ? "default" : "outline"}`
);

code = code.replace(
  /className=\{cn\("h-9 rounded-lg transition-all", formData\.isActive \? "bg-emerald-500 hover:bg-emerald-600 text-white shadow-lg shadow-emerald-500\/20" : ""\)\}/g,
  `className="h-9 rounded-lg transition-all w-[100px]"`
);

fs.writeFileSync(filePath, code);
console.log("Fixed Active toggle button in plans page");
