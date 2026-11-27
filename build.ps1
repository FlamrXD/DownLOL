npx esbuild server.js --bundle --platform=node --format=cjs --outfile=dist/bundle.cjs
node --build-sea sea-config.json
mv downlol.exe dist
cp -r public dist
