# StudyVault (MVP)

Upload study material, get it organized automatically, search it, and ask questions answered only from your own files.

## Run
```
cp .env.example .env   # set JWT_SECRET (export it, or use `node --env-file=.env server.js`)
npm install
npm run dev            # http://localhost:3000
```
Optional: set `OPENAI_API_KEY` for LLM-written answers. Without it, answers are the best-matching passages from your files.

## What works
Register/login (bcrypt + HTTP-only JWT cookie), upload with size/type/PDF-signature checks and random server-side filenames,
duplicate detection (SHA-256), background processing (PDF and TXT text extraction with page numbers, chunking, auto subject/topic/type),
processing states, library by subject, favorites, metadata editing, delete, keyword search over metadata and text,
document viewer, RAG-style Ask AI with page citations and a "couldn't find this" fallback. All queries are scoped to the logged-in user;
files are served only through an authenticated endpoint.

## Not yet built (next steps)
Postgres/Prisma, S3 storage, Redis/BullMQ, OCR and DOCX/PPTX text extraction, real embeddings (search is keyword-based; swap `retrieve()`),
collections, Exam Mode, flashcards/summaries endpoints, onboarding slides, tests.
