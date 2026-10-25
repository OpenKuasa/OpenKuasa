---
title: Import contacts from a file
description: Bring contacts into Kasturi from a CSV or Excel file, up to 500 rows at a time, without making duplicates.
order: 4
ask: How do I import my contacts from a CSV or Excel file into Kasturi?
screen: /crm/contacts
---
You can add many contacts at once from a spreadsheet. Kasturi matches your columns to its fields, shows what it will import, and skips anyone already in the workspace.

## Who can do this

Owners, admins and members can import contacts. Viewers cannot.

## Before you start

- Save your list as a .csv or .xlsx file. An older .xls file needs to be saved as .xlsx first.
- The first line must be the column names.
- Every contact needs a first name and an email.
- One file can hold up to 500 contacts. Split a longer list into several files.

A CSV file can use commas, semicolons or tabs between values. Kasturi works out which from the first line.

## Steps

1. Open **Kasturi** and choose **Contacts**.
2. Click **Add Contact**, then **Import from CSV or Excel**.
3. Choose your file. Nothing is sent yet; the file is read in your browser.
4. Under **Match the columns in** your file's name, check which column feeds each field. Kasturi guesses from the column names. **First name** and **Email** are marked with a star because they are needed. Choose **Not in this file** for a field you do not have.
5. Read the summary. It says how many contacts are ready to import and how many rows will be skipped. Open **Why rows are skipped** to see each reason by line.
6. Click **Import** (the button shows how many contacts it will import).
7. Kasturi tells you how many were imported, how many were already in the workspace, and how many rows were skipped.

### How your file is read

- If you have one name column, such as **Name** or **Full name**, the first word becomes the first name and the rest the last name.
- The country can be a two-letter code (MY) or a country name in English or Malay (Singapore, Singapura). An empty country becomes MY.
- Status words such as New, Contacted, Qualified, Customer and Archived are understood. Anything else becomes a new lead.
- A lead score is kept between 0 and 100.
- Tags are separated by commas.

### Duplicates

- A contact whose email is already in the workspace is left as it is. It is not changed or added again.
- If the same email appears twice in your file, only the first row is imported.

## Common problems

- **Choose a .csv or .xlsx file. Older .xls files need to be saved as .xlsx first.**: save the file in one of those formats.
- **That file has no rows under its header line.**: the file has only column names.
- **Choose the columns for first name and email.**: match both fields before you import.
- **The file has … rows. Only the first 500 are read; import the rest from a second file.**: split the list and import the rest from another file.
- **Country "…" is not recognised. Use a name such as Malaysia or a two-letter code such as MY.**: fix the country in that row.
- Rows are also skipped for the same reasons a single contact is refused, such as a missing first name or an email that is not valid.

## Related

- [Add and manage contacts](/docs/kasturi/contacts)
- [Kasturi settings](/docs/kasturi/settings)
