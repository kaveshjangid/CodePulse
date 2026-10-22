import express from 'express';import cors from 'cors';import multer from 'multer';import AdmZip from 'adm-zip';import fs from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';import {scanArchive} from './scanner.js';
const dir=path.dirname(fileURLToPath(import.meta.url)),dataDir=path.resolve(dir,'../data'),store=path.join(dataDir,'scans.json'),port=Number(process.env.PORT)||5000,app=express();
app.disable('x-powered-by');app.use(cors({origin:(origin,cb)=>{const allowed=(process.env.CLIENT_ORIGIN||'http://localhost:5173').split(',').map(x=>x.trim());if(!origin||allowed.includes(origin)||process.env.NODE_ENV!=='production')return cb(null,true);return cb(Error('Origin not allowed by CORS'))}}));app.use(express.json({limit:'100kb'}));
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:15*1024*1024,files:1},fileFilter:(_req,file,cb)=>file.originalname.toLowerCase().endsWith('.zip')?cb(null,true):cb(Object.assign(Error('Only .zip files are supported.'),{status:400}))});
async function readScans(){try{const a=JSON.parse(await fs.readFile(store,'utf8'));return Array.isArray(a)?a:[]}catch(e){if(e.code==='ENOENT')return[];console.error('Scan history read failed:',e.message);return[]}}
async function saveScan(scan){await fs.mkdir(dataDir,{recursive:true});const all=[scan,...(await readScans()).filter(s=>s.id!==scan.id)].slice(0,50),tmp=store+'.tmp';await fs.writeFile(tmp,JSON.stringify(all,null,2),'utf8');await fs.rename(tmp,store)}
app.get('/api/health',(_req,res)=>res.json({ok:true,service:'codepulse-api',version:'1.0.0',time:new Date().toISOString()}));
app.get('/api/scans',async(_req,res,next)=>{try{res.json({scans:await readScans()})}catch(e){next(e)}});
app.get('/api/scans/:id',async(req,res,next)=>{try{const scan=(await readScans()).find(s=>s.id===req.params.id);if(!scan)return res.status(404).json({error:'Scan not found.'});res.json({scan})}catch(e){next(e)}});
app.post('/api/scans/upload',upload.single('project'),async(req,res,next)=>{try{if(!req.file)return res.status(400).json({error:'Choose a ZIP file to scan.'});let zip;try{zip=new AdmZip(req.file.buffer)}catch{return res.status(400).json({error:'This file is not a valid ZIP archive.'})}const scan=await scanArchive(zip,req.file.originalname);scan.source={type:'zip'};await saveScan(scan);res.status(201).json({scan})}catch(e){next(e)}});

app.post('/api/scans/github', async (req, res, next) => {
  try {
    const repositoryUrl = String(req.body?.repositoryUrl || '').trim();
    let parsed;
    try {
      parsed = new URL(repositoryUrl);
    } catch {
      return res.status(400).json({ error: 'Enter a valid public GitHub repository URL.' });
    }
    if (parsed.hostname !== 'github.com' || parsed.protocol !== 'https:') {
      return res.status(400).json({ error: 'Only public repositories hosted on https://github.com are supported.' });
    }
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length < 2 || !/^[A-Za-z0-9_.-]+$/.test(parts[0]) || !/^[A-Za-z0-9_.-]+$/.test(parts[1])) {
      return res.status(400).json({ error: 'Use a repository URL like https://github.com/owner/repository.' });
    }
    const owner = parts[0];
    const repository = parts[1].replace(/\.git$/i, '');
    const archiveUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/zipball/HEAD`;
    const response = await fetch(archiveUrl, {
      headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'CodePulse-Repository-Scanner' },
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) {
      return res.status(response.status === 404 ? 404 : 502).json({
        error: response.status === 404
          ? 'Repository not found or not public. Check the URL and try again.'
          : `GitHub could not provide this archive (HTTP ${response.status}).`
      });
    }
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > 15 * 1024 * 1024) {
      return res.status(413).json({ error: 'GitHub repository archive exceeds the 15 MB download limit.' });
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 15 * 1024 * 1024) {
      return res.status(413).json({ error: 'GitHub repository archive exceeds the 15 MB download limit.' });
    }
    const zip = new AdmZip(bytes);
    const scan = await scanArchive(zip, `${owner}-${repository}.zip`);
    scan.source = { type: 'github', repositoryUrl: `https://github.com/${owner}/${repository}` };
    await saveScan(scan);
    res.status(201).json({ scan });
  } catch (error) {
    next(error);
  }
});

app.use((e,_req,res,_next)=>{if(e instanceof multer.MulterError)return res.status(e.code==='LIMIT_FILE_SIZE'?413:400).json({error:e.code==='LIMIT_FILE_SIZE'?'ZIP upload is too large. Maximum size is 15 MB.':e.message});const status=Number(e.status)||500;if(status>=500)console.error(e);res.status(status).json({error:status>=500?'Something went wrong while processing the request.':e.message})});
app.listen(port,()=>console.log(`CodePulse API listening on http://localhost:${port}`));