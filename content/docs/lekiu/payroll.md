---
title: Run payroll
description: Create a monthly payroll draft, check and adjust each payslip, then mark the run as paid.
order: 80
ask: How do I run payroll for this month in Lekiu?
screen: /people/payroll
---
On **Payroll**, owners and admins run payroll month by month. A run starts as a draft that employees cannot see. When you mark it as paid, each employee sees their payslip on **My Payslips**.

Marking a run as paid only records it in OpenKuasa. It does not move any money, make a bank file, or submit anything to EPF, SOCSO, EIS or LHDN. You pay and submit those yourself. It also posts nothing to Bendahara, so record the salaries there separately.

## Who can do this

Owners and admins. The screen is hidden from everyone else, and shows "This page is for owners and admins of the workspace." if opened. In the demo workspace the screen can be read but nothing can be run or changed.

## Before you start

Each employee needs a **Monthly base salary (RM)** on their record. Someone with no base salary is left out of the run, with the reason "No base salary recorded". See [Add and edit employees](/docs/lekiu/add-and-edit-employees).

## Steps

![The Payroll screen with a draft run, its totals and the payslips table](/docs-media/lekiu/payroll.png)

This screenshot is from the demo workspace, where **Run payroll** is switched off and shows "Available in a later update". In your own workspace **Run payroll** opens the run dialog, unless a draft run is blocking the next month or there is no month left to run.

### Create a draft

1. Open **Lekiu**, then **Payroll** under **Payroll**.
2. Click **Run payroll**.
3. For your first run, pick the **Month**. The first run can be any month up to this one. Choose it with care: after that, months follow one another and none can be skipped, so the dialog shows the next month.
4. Click **Create draft**. Nobody is paid and employees can't see it yet.

The screen shows "Draft: employees can't see this yet". It also notes overtime claims from earlier months that the run picked up, and active employees who are not on the run.

### Check and adjust payslips

1. In **Payslips**, click an employee's name to open their payslip.
2. To add pay or a deduction, click **Add line**, choose **Earning (adds to gross)** or **Deduction (comes off net)**, type a name and the amount, and click **Save line**. Lines you added can be edited or removed. Lines added by the system cannot: overtime ("Overtime," with the date and hours), unpaid leave ("Unpaid leave," with the days) and the unpaid days before a new joiner started ("Joined" with the date).
3. Check EPF, SOCSO, EIS and PCB. The payslip says: "Proposed figures. Check them before marking the run as paid." Know how they are filled in:
   - **EPF, SOCSO and EIS** are simple estimates of the employee's share, worked out from gross pay, so overtime and every earning line you add raise them. They are not the official contribution tables, so check each one. Employer shares are not worked out or shown.
   - **PCB is not worked out.** It is copied from the employee's last paid payslip, or RM 0.00 if there is none. A first run and a new joiner get RM 0.00, and PCB does not change when salary, overtime or other pay changes. Enter the correct PCB for each employee every month.
4. To use your own amount, type it and click **Save**. The figure is then marked **set by HR** and stays fixed, even when you click **Recalculate**. Click **Reset** to go back to the proposed amount. After changing salary, overtime or lines, click **Reset** or check the figures you set again.
5. To take someone off this draft, click **Remove payslip**, then **Confirm**. **Recalculate** would bring it back.

Click **Recalculate** after changing salaries or overtime. It adds payslips for anyone new.

### Mark the run as paid

1. Click **Mark as paid**, then **Confirm**. Employees can now see their payslips.

To change a paid run, click **Undo paid**, then **Confirm**. The run goes back to a draft, its payslips go back to pending, and employees no longer see them. Only the newest run can be undone: if a later month already has a run, delete that run first. Only a draft can be deleted, so if that later run is paid, click **Undo paid** on it first, then **Delete draft**. To throw a draft away, click **Delete draft**, then **Confirm**.

Be careful when undoing and deleting later runs: deleting a run deletes its payslips and their lines. Every line typed in and every EPF, SOCSO, EIS or PCB figure marked **set by HR** in those months is lost. When you run those months again, PCB is copied afresh from the employee's last paid payslip.

Use the **Month** list at the top to open an earlier run. **Export** is a disabled button that says "Available in a later update".

## Common problems

- **"Mark … as paid or delete it before running the next month."** Only one draft at a time.
- **"A payslip's net pay is below zero. Fix it before marking the run as paid."**
- **"An overtime claim on this run has changed. Recalculate first."**
- **"Run payroll for the month after the latest run first."** Months cannot be skipped.
- **"That line is worked out by the system and can't be changed."**
- **"Every month up to now already has a payroll run."** There is no month left to run yet.
- **"A later month already has a payroll run. Delete that run first."** You can only undo paid on the newest run.

## Related

- [Payment vouchers](/docs/lekiu/payment-vouchers)
- [My payslips](/docs/lekiu/my-payslips)
- [Approve or reject overtime](/docs/lekiu/approve-overtime)
