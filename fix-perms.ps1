$path = "D:\VM\hsk-testing_key.pem"
$acl = Get-Acl $path
$acl.SetAccessRuleProtection($true, $false)
$acl.Access | ForEach-Object { $acl.RemoveAccessRule($_) }
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule([System.Security.Principal.WindowsIdentity]::GetCurrent().Name, "FullControl", "Allow")
$acl.AddAccessRule($rule)
Set-Acl -Path $path -AclObject $acl
