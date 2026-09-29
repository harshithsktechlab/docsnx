---
name: deduplication-enforcer
description: Automatically enforces a standardized deduplication architecture across all modules when creating or modifying features to prevent duplicate records.
---

# Deduplication Enforcer Skill

This skill enforces a standard "Soft Warning" deduplication architecture across the DocsNX multi-tenant platform.

## Trigger Conditions
You MUST proactively trigger this skill and apply these rules whenever you are tasked with:
1. Creating a completely new module (e.g., "Vehicles", "Inventory", "Tasks") that involves storing records.
2. Modifying the backend API routes or frontend forms of an existing module that manages records.

## Rules & Enforcement

### 1. Define Unique Identifiers
For every module you work on, you must explicitly identify what constitutes a "duplicate".
- Example for Bank Info: `accountNumber` and `bankName`.
- Example for Credit Cards: `cardNumber`.
- Example for Passwords: `websiteUrl` and `username`.
These identifiers must be checked against the database before saving.

### 2. Backend API Enforcement (Soft Warning)
In the API route handling the record creation or update (`POST` or `PUT`):
1. **Extract `forceSave`**: Extract a boolean `forceSave` flag from the request body.
2. **Query for Duplicates**: Query the database using the unique identifiers, scoping the query to the current user's `tenantId`.
3. **Handle Duplicates**:
   - If a duplicate record is found AND `forceSave` is falsy (or undefined), you MUST NOT save the record. Instead, return a `409 Conflict` response:
     ```typescript
     return NextResponse.json({ 
       error: 'A record with these details already exists.', 
       requiresConfirmation: true 
     }, { status: 409 });
     ```
   - If a duplicate record is found AND `forceSave === true`, bypass the duplicate check and proceed with saving/updating the record.

### 3. Frontend UI Integration
In the frontend React component that handles form submission:
1. **Catch 409 Status**: Inspect the API response for a `409` status code or the `requiresConfirmation: true` flag.
2. **Show Confirmation Dialog**: Do not just show a standard error toast. You must present the user with a confirmation dialog (e.g., using the `window.confirm` API or a custom modal):
   - Example: `const proceed = window.confirm("A record with this identifier already exists. Do you want to save it anyway?");`
3. **Resubmit with `forceSave`**: If the user confirms (`proceed === true`), immediately resend the exact same API request, but append `forceSave: true` to the JSON payload. If the user cancels, abort the operation.
