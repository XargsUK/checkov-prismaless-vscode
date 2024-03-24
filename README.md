[![build status](https://github.com/XargsUK/checkov-prismaless-vscode/workflows/build/badge.svg)](https://github.com/XargsUK/checkov-prismaless-vscode/actions?query=workflow%3Abuild)
[![Installs-count](https://vsmarketplacebadges.dev/installs-short/XargsUK.checkov-prismaless.png)](https://marketplace.visualstudio.com/items?itemName=XargsUK.checkov-prismaless)

# Checkov Extension for Visual Studio Code

[Checkov](https://github.com/bridgecrewio/checkov) is a static code analysis tool for infrastructure-as-code, secrets, and software composition analysis.

This extension is a fork of the original BridgeCrew extension, with the removal of the PrismaCloud API dependancies. This forked extension can be found on the [Visual Studio Extension Marketplace](https://marketplace.visualstudio.com/items?itemName=XargsUK.checkov-prismaless) and its source code is available in an [Apache 2.0 licensed repository](https://github.com/XargsUK/checkov-prismaless-vscode).  The original extension can be found on the [Visual Studio Extension Marketplace](https://marketplace.visualstudio.com/items?itemName=Bridgecrew.checkov) and its source code is available in an [Apache 2.0 licensed repository](https://github.com/bridgecrewio/checkov-vscode). This extension is downstream from the original extension. 

The Checkov Extension for Visual Studio Code enables developers to get real-time scan results, as well as inline fix suggestions as they develop cloud infrastructure.

Extension features include:

* [1000+ built-in policies](https://github.com/bridgecrewio/checkov/blob/master/docs/5.Policy%20Index/all.md) covering security and compliance best practices for AWS, Azure and Google Cloud.
* Terraform, Terraform Plan, CloudFormation, Kubernetes, Helm, Serverless and ARM template scanning.
* Detects [AWS credentials](https://github.com/bridgecrewio/checkov/blob/master/docs/2.Basics/Scanning%20Credentials%20and%20Secrets.md) in EC2 Userdata, Lambda environment variables and Terraform providers.
* In Terraform, checks support evaluation of arguments expressed in [variables](https://github.com/bridgecrewio/checkov/blob/master/docs/2.Basics/Handling%20Variables.md) and remote modules to their actual values.
* Supports inline [suppression](https://github.com/bridgecrewio/checkov/blob/master/docs/2.Basics/Suppressing%20and%20Skipping%20Policies.md) via comments.
* Links to policy descriptions, rationales as well as step by step instructions for fixing known misconfigurations.
* Fix suggestions for commonly misconfigured Terraform and CloudFormation attributes.

## Getting started

### Install

Open the LocalCheckov Extension for Visual Studio Code in the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=XargsUK.checkov-prismaless) and install. 

### Dependencies

* [Python](https://www.python.org/downloads/) >= 3.7 or [Pipenv](https://docs.pipenv.org/) or [Docker](https://www.docker.com/products/docker-desktop) daemon running

The Checkov extension will invoke the latest version of ```Checkov```.


### Usage

* Open a file you wish to scan with checkov in VSCode.
* Open the command palette (⇧⌘P) and run the command `Checkov Scan`.
* Scan results should now appear in your editor.
* Click a scan to see its details. Details will include the violating policy and a link to step-by-step fix guidelines.
* In most cases, the Details will include a fix option. This will either add, remove or replace an unwanted configuration, based on the Checkov fix dictionaries.
* You can skip checks by adding an inline skip annotation ```checkov:skip=<check_id>:<suppression_comment>```.
* The extension will continue to scan file modifications and highlight errors in your editor upon every material resource modification.

### Troubleshooting logs

To access checkov-primsaless-vscode logs directory, open the VSCODE Command Palette `(Ctrl+Shift+P)` or `(Command+Shift+P)`, and run the command `Open Checkov Log`. It is helpful if you delete the log file and then re-try whichever operation was failing in order to produce clean logs.



