import React from 'react';

export default function GradientPreview() {
  return (
    <div className="p-12 min-h-screen bg-background flex flex-col gap-12">
      <h1 className="text-3xl font-bold mb-4">Gradient Options for DocsNX</h1>
      
      <div>
        <h2 className="text-xl mb-2 text-muted-foreground">Option 1: Primary to Orange (Current landing page style)</h2>
        <span className="text-5xl font-black text-transparent bg-clip-text bg-gradient-to-r from-primary to-orange-400">
          DocsNX
        </span>
      </div>
      
      <div>
        <h2 className="text-xl mb-2 text-muted-foreground">Option 2: Primary to Purple (Tech sleek)</h2>
        <span className="text-5xl font-black text-transparent bg-clip-text bg-gradient-to-r from-primary to-purple-500">
          DocsNX
        </span>
      </div>

      <div>
        <h2 className="text-xl mb-2 text-muted-foreground">Option 3: Brand 500 to Brand 900 (Subtle depth)</h2>
        <span className="text-5xl font-black text-transparent bg-clip-text bg-gradient-to-r from-primary to-blue-900">
          DocsNX
        </span>
      </div>
    </div>
  );
}
