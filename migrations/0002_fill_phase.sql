-- Proposed only: preserve futures entry/exit semantics. Legacy rows remain NULL.
ALTER TABLE fills ADD COLUMN phase TEXT CHECK (phase IS NULL OR phase IN ('entry', 'exit'));
